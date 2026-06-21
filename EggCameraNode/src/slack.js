const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const https = require('node:https');

const { ts } = require('./config');

// Webhook URL は process.env か ~/EggCamera/.env.slack（git管理外）から読む。
function webhookUrl() {
    if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL;
    try {
        const f = path.join(os.homedir(), 'EggCamera', '.env.slack');
        const line = fs.readFileSync(f, 'utf8').split('\n').find(l => l.startsWith('SLACK_WEBHOOK_URL='));
        return line ? line.slice('SLACK_WEBHOOK_URL='.length).trim() : null;
    } catch { return null; }
}

// 同種通知の連投を防ぐスロットル（key ごとの最小間隔）
const lastSentAt = new Map();
const HOST = (() => { try { return os.hostname(); } catch { return 'mac-mini'; } })();

const ICON = { warn: ':warning:', alert: ':rotating_light:', info: ':information_source:', fix: ':white_check_mark:' };

// アクション種別タグ — 受信者が「何をすべきか」を一目で判断できるよう先頭行に出す。
//   none=対処不要 / fix=コード・設定の修正 / restart=再起動や物理操作 / investigate=原因調査
const ACTION_TAG = {
    none:        ':white_check_mark: *通知：対処不要*',
    fix:         ':wrench: *要修正：コード/設定を確認*',
    restart:     ':electric_plug: *要再起動／物理操作*',
    investigate: ':mag: *要調査：原因を確認*',
};
// action 未指定時に level から補完するデフォルト。
const LEVEL_DEFAULT_ACTION = { info: 'none', fix: 'none', warn: 'investigate', alert: 'investigate' };

// notify(text, { level, action, key, throttleMs })
//   action を明示すると先頭タグが決まる。未指定なら level から補完。
function notify(text, { level = 'warn', action = null, key = null, throttleMs = 0 } = {}) {
    if (key && throttleMs > 0) {
        const last = lastSentAt.get(key) || 0;
        if (Date.now() - last < throttleMs) return false;
        lastSentAt.set(key, Date.now());
    }
    const url = webhookUrl();
    if (!url) { console.warn(`[${ts()}] Slack未設定のため通知スキップ: ${text.slice(0, 80)}`); return false; }

    const tag = ACTION_TAG[action] || ACTION_TAG[LEVEL_DEFAULT_ACTION[level]] || ACTION_TAG.investigate;
    const body = JSON.stringify({ text: `${tag}\n${ICON[level] || ''} *EggCamera* (${HOST})\n${text}` });
    try {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 10_000,
        }, res => res.resume());
        req.on('error', err => console.error(`[${ts()}] Slack通知失敗: ${err.message}`));
        req.on('timeout', () => req.destroy());
        req.write(body);
        req.end();
        return true;
    } catch (err) {
        console.error(`[${ts()}] Slack通知エラー: ${err.message}`);
        return false;
    }
}

module.exports = { notify };
