'use strict';
// カメラ・ウォームアップ（捨て撮り1回・ロックしない）。
//
// Mac/iPhone の再起動やアプリ再起動(iphone.sh run/restart/reboot/refresh)直後は、カメラ写真
// パイプラインが cold で最初の1撮影が低解像(12MP)になる race がある（直後に48MPへ復帰）。この
// 捨て撮りが「最初の1枚」を肩代わりし、実客が cold-start を踏まないようにする。
//   - boot時: server.js が呼ぶ（selftest が走らない再起動の保険）
//   - iPhoneアプリ再起動後: adminCore の POST /warmup を iphone.sh フックが叩く（本番の再起動経路）
// ※ 夜間などの 12MP は iOSの低照度ビニング（照明依存）で、warmup では直らない別問題。
//   ここが吸収するのは「再起動直後の cold-start race」のみ。
const fs       = require('node:fs');
const { CAPTURE_TIMEOUT_MS, ts } = require('./config');
const camera   = require('./adapters/camera');
const sessions = require('./sessions');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let warming = false; // 多重発火防止（boot warmup と iphone.sh フックが近接して重なりうる）
function isWarming() { return warming; }

// 実撮影側が warmup 完了を待つ（捨て撮りと実撮影の同時発火＝iPhone側 in-flight 拒否を防ぐ）。
// 上限つき: 超えたら諦めて撮影に進む（最悪でも従来と同じ挙動）。
async function waitUntilWarm(maxMs = 10_000) {
    const deadline = Date.now() + maxMs;
    while (warming && Date.now() < deadline) await sleep(200);
    return !warming;
}

// 捨て撮りを最大 maxMs の間だけ試みる。mac未応答は再試行。
// 実撮影を検知したら待避でなく中止する: 実シャッター自体がカメラを温めるため捨て撮りは不要になり、
// 待避して再試行を続けると実撮影の合間（連写の切れ目）に割り込んで並走しうる（2026-07-04 21/22時枠の
// wake-warmup×テストC1衝突）。中止がwarmup直列化の要。
async function warmupCamera({ reason = '', maxMs = 60_000 } = {}) {
    if (warming) { console.log(`[${ts()}] camera warmup skip: 既にwarming中`); return false; }
    warming = true;
    try {
        const startedAt = Date.now();
        const realCaptureSeen = () =>
            sessions.anyCapturing() || sessions.lastCaptureStart() >= startedAt;
        const deadline = Date.now() + maxMs;
        for (let attempt = 1; Date.now() < deadline; attempt++) {
            if (realCaptureSeen()) {
                console.log(`[${ts()}] camera warmup 中止: 実撮影を検知（実シャッターが温めるため捨て撮り不要）`);
                return false;
            }
            try {
                const t0 = Date.now();
                const { rawPath } = await camera.capture(CAPTURE_TIMEOUT_MS);
                // 捨て撮り待ちの間に実客の撮影が並走開始していた場合、waitForNewRawFile は
                // 「sinceMs より新しい最初のファイル」を返すだけでトリガーとの対応保証が無く、
                // この rawPath が実客の1枚である可能性がある。削除すると実客の合成元を失うため
                // 削除せず孤児raw GC に委ねる（最悪でも余分な1枚が残るだけ）。
                if (sessions.anyCapturing() || sessions.lastCaptureStart() > t0) {
                    console.warn(`[${ts()}] camera warmup: 実撮影と並走検知 → 捨て撮りrawを削除せず孤児GCに委ねる (${rawPath})`);
                } else {
                    fs.rm(rawPath, { force: true }, () => {}); // 捨て撮り: セッション/合成/アップには載せない
                }
                console.log(`[${ts()}] camera warmup OK (attempt ${attempt}${reason ? ' / ' + reason : ''}) → cold-start吸収`);
                return true;
            } catch (err) {
                console.log(`[${ts()}] camera warmup retry (${attempt}): ${err.message}`);
                if (realCaptureSeen()) continue; // 5秒待たず即loop先頭の中止判定へ
                await sleep(5000);
            }
        }
        console.log(`[${ts()}] camera warmup: カメラ未応答のまま諦め（post-boot ipad-test/実撮影で温まる）`);
        return false;
    } finally {
        warming = false;
    }
}

module.exports = { warmupCamera, isWarming, waitUntilWarm };
