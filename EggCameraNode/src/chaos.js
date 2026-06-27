// 長期運用テスト用のフォールトインジェクション。
// /api/admin/chaos で「次の N 回だけ」特定箇所をわざと失敗させる。
// 本番フローへの影響は consume() を呼ぶ 3 箇所の if 文のみ。
//
// 安全装置: .env に CHAOS_ENABLED=1 が無い限り完全に無効。
// arm() は拒否され、consume() は常に false（本番では絶対に発火しない）。
// 運用テスト期間だけ CHAOS_ENABLED=1 を設定し、本番では外すこと。
const { ts } = require('./config');

const ENABLED = process.env.CHAOS_ENABLED === '1';

const armed = {
    capture: 0, // 撮影トリガーを mac-unreachable で失敗させる
    r2:      0, // R2 アップロードを失敗させる
    qr:      0, // QR 生成を失敗させる
    compose: 0, // サーバ側合成(/compose)を失敗させる
};

function arm(target, count = 1) {
    if (!ENABLED) {
        console.warn(`[${ts()}] CHAOS rejected (CHAOS_ENABLED!=1): ${target}`);
        return false;
    }
    if (!(target in armed)) return false;
    armed[target] += Math.max(1, Math.min(10, count | 0));
    console.warn(`[${ts()}] CHAOS armed: ${target} x${armed[target]}`);
    return true;
}

// 直近の発火履歴（最新10件）。テスト拡張が「注入なしでオーバーレイ」を実バグと
// 断定する前に、armed済みカウントが消費済みの残留フォルト由来かを照会するのに使う。
const recentFired = [];

function consume(target) {
    if (!ENABLED) return false;
    if (armed[target] > 0) {
        armed[target]--;
        recentFired.push({ target, at: Date.now() });
        if (recentFired.length > 10) recentFired.shift();
        console.warn(`[${ts()}] CHAOS fired: ${target}`);
        return true;
    }
    return false;
}

function reset() {
    for (const k of Object.keys(armed)) armed[k] = 0;
    console.warn(`[${ts()}] CHAOS reset`);
}

// クライアント側(ページ内 hook)注入フォルトの「予告窓」。
// armServerFaults はサーバの consume() を通るので recentFired に乗るが、
// createSession/capture/compose/confirm/js の hook 注入は fetch 差し替え＝サーバを通らないため
// recentFired に乗らない。これが無いと incident は hook 由来の致命エラーを「実障害(要調査)」と
// 誤判定して⚠️を出す（2026-06-27 createSession injected_fault の誤アラートの原因）。
// ハーネスが hook 注入時にここへ予告を立て、incident が「テスト注入(info)」と判定できるようにする。
// CHAOS_ENABLED 時のみ有効＝本番では常に無効＝実客の致命エラーは従来どおり「要調査」になる。
let clientExpectUntil = 0;
let clientExpectLabel = '';
function expectClient(label, ttlMs = 600_000) {
    if (!ENABLED) return false;
    clientExpectUntil = Date.now() + ttlMs;
    clientExpectLabel = label || 'client-hook';
    console.warn(`[${ts()}] CHAOS client-expect: ${clientExpectLabel}`);
    return true;
}
function clearClientExpect() { clientExpectUntil = 0; clientExpectLabel = ''; }

// 直近 withinMs(既定15秒) 以内に CHAOS が発火していれば、その発火記録 {target, at} を返す
// （なければ null）。incident 通知が「致命エラーは毎時テストのフォルト注入由来か」を判定する用。
// CHAOS は本番では無効(ENABLED=false)なので、本番では常に null＝実障害として扱われる。
function recentlyFired(withinMs = 15_000) {
    if (!ENABLED) return null;
    const cutoff = Date.now() - withinMs;
    for (let i = recentFired.length - 1; i >= 0; i--) {
        if (recentFired[i].at >= cutoff) return recentFired[i];
    }
    // サーバを通らない client/js hook 注入は予告窓で判定する
    if (clientExpectUntil && Date.now() < clientExpectUntil) {
        return { target: clientExpectLabel, at: Date.now(), client: true };
    }
    return null;
}

function status() {
    return {
        enabled: ENABLED, ...armed, recentFired,
        clientExpect: clientExpectUntil ? { label: clientExpectLabel, until: clientExpectUntil } : null,
    };
}

module.exports = { arm, consume, reset, status, recentlyFired, expectClient, clearClientExpect };
