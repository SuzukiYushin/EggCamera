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

function consume(target) {
    if (!ENABLED) return false;
    if (armed[target] > 0) {
        armed[target]--;
        console.warn(`[${ts()}] CHAOS fired: ${target}`);
        return true;
    }
    return false;
}

function reset() {
    for (const k of Object.keys(armed)) armed[k] = 0;
    console.warn(`[${ts()}] CHAOS reset`);
}

function status() {
    return { enabled: ENABLED, ...armed };
}

module.exports = { arm, consume, reset, status };
