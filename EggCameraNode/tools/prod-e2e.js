#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
// 本番実パスの API E2E（iPad/Safari を使わない）。
//
//   POST /api/sessions              → セッション作成
//   POST /api/sessions/:id/capture  → iPhone 実撮影 ×3（本番と同じ枚数）
//   POST /api/sessions/:id/compose  → サーバ側 sharp 合成（composed_pending ジョブ）
//   POST /api/sessions/:id/confirm  → 決定（QR即発行 + uploadWorker へ enqueue）
//   GET  /api/jobs/:jobId/status    → アップロード完了待ち
//   GET  DLページ / R2画像           → 配信物の到達確認
//
// tools/api-soak.js は旧クライアント合成(/composite)・撮影1枚しか叩かず、2026-06-25 の
// サーバ合成カットオーバー以降の本流(compose/confirm/uploadWorker)を検証できない。
// iPad が使えない間の毎時テストはこちらを使う（ops/ipad/hourly-ipad-test.sh が呼ぶ）。
//
// 使い方: node tools/prod-e2e.js [--cycles N] [--days N] [--nickname X] [--quiet]
// 終了コード: 0=全サイクル成功 / 1=1つでも失敗
// ─────────────────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');

const BASE  = process.env.E2E_BASE  || 'http://127.0.0.1:3000';
const ADMIN = process.env.E2E_ADMIN || 'http://127.0.0.1:3001';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CYCLES = parseInt(argOf('--cycles', '1'), 10);
const DAYS   = parseInt(argOf('--days', '0'), 10);   // 0 = サイクルごとにレベルを散らす
const NICK   = argOf('--nickname', 'E2Eテスト');
const QUIET  = argv.includes('--quiet');

// days=0 のときに使う代表値（成長フレーム lv1/lv5/lv9 + レア域を薄く踏む）
const DAYS_ROTATION = [300, 530, 900, 450, 700, 1000];

const ENV_PATH = path.resolve(__dirname, '../.env');
const ADMIN_TOKEN = (() => {
    try {
        const m = fs.readFileSync(ENV_PATH, 'utf8').match(/^ADMIN_TOKEN=(.*)$/m);
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch { return ''; }
})();

const log = (...a) => { if (!QUIET) console.log(new Date().toLocaleTimeString('ja-JP'), ...a); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`${method} ${url.replace(BASE, '')} → ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
    return json;
}

async function runCycle(i) {
    const days = DAYS || DAYS_ROTATION[(i - 1) % DAYS_ROTATION.length];

    const { sessionId } = await api('POST', `${BASE}/api/sessions`);

    // 撮影3枚（不変条件「撮影枚数は3の倍数」を守る＝本番と同じ）
    const photos = [];
    for (let s = 1; s <= 3; s++) {
        const p = await api('POST', `${BASE}/api/sessions/${sessionId}/capture`);
        photos.push(p.photoId);
    }

    // サーバ合成（真ん中の1枚を選択）
    const t0 = Date.now();
    const compose = await api('POST', `${BASE}/api/sessions/${sessionId}/compose`, {
        photoId: photos[1], nickname: NICK, daysText: `生後${days}日`, days,
    });
    const composeMs = Date.now() - t0;
    if (!compose.thumbDataUrl) throw new Error('compose: thumbDataUrl が空');

    // 決定（QR発行 + アップロード投入）
    const confirm = await api('POST', `${BASE}/api/sessions/${sessionId}/confirm`, { jobId: compose.jobId });
    if (!confirm.downloadUrl) throw new Error('confirm: downloadUrl が空');

    // アップロード完了待ち（最大120秒）
    let done = false, attempts = 0, status = '?';
    for (let w = 0; w < 60; w++) {
        await sleep(2000);
        const st = await api('GET', `${BASE}/api/jobs/${compose.jobId}/status`);
        status = st.status; attempts = st.attempts || 0;
        if (st.done) { done = true; break; }
        if (String(st.status).includes('failed')) throw new Error(`upload失敗: ${st.status}`);
    }
    if (!done) throw new Error(`アップロード未完了 (status=${status} attempts=${attempts})`);

    // 配信物の到達確認（DLページ + R2画像）
    const dl = await fetch(confirm.downloadUrl, { redirect: 'follow' });
    if (!dl.ok) throw new Error(`DLページ ${dl.status}`);
    const imgUrl = confirm.downloadUrl.replace('/download?id=', '/image/') + '.jpg';
    const img = await fetch(imgUrl);
    if (!img.ok) throw new Error(`R2画像 ${img.status}`);
    const bytes = (await img.arrayBuffer()).byteLength;

    // セッションの不変条件（撮影3枚・done）
    const session = await api('GET', `${BASE}/api/sessions/${sessionId}`);
    if ((session.photos || []).length !== 3) throw new Error(`写真枚数=${(session.photos || []).length} (期待3)`);
    if (session.status !== 'done') throw new Error(`session.status=${session.status} (期待done)`);

    log(`#${i} OK days=${days} 合成${composeMs}ms job=${compose.jobId} DL=200 R2=200 (${Math.round(bytes / 1024)}KB)`);
    return true;
}

(async () => {
    let ok = 0, ng = 0;
    const errors = [];
    for (let i = 1; i <= CYCLES; i++) {
        try {
            await runCycle(i);
            ok++;
        } catch (err) {
            ng++;
            errors.push(`#${i}: ${err.message}`);
            log(`#${i} 失敗: ${err.message}`);
        }
        if (i < CYCLES) await sleep(5000);
    }

    // RSS も添える（合成バーストでの肥大を毎回見張る）
    let rss = '?';
    try {
        const res = await fetch(`${BASE}/api/admin/metrics`, { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
        if (res.ok) rss = `${(await res.json()).rssMB}MB`;
    } catch { /* 参考値なので握りつぶす */ }

    console.log(`=== E2E完了: 成功${ok} 失敗${ng} / ${CYCLES}サイクル rss=${rss} ===`);
    if (errors.length) console.log(errors.join(' | '));
    process.exit(ng ? 1 : 0);
})().catch(err => { console.error(`E2E異常終了: ${err.message}`); process.exit(1); });
