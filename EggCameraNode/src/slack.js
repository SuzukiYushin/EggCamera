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

// notify(text, { level, key, throttleMs })
function notify(text, { level = 'warn', key = null, throttleMs = 0 } = {}) {
    if (key && throttleMs > 0) {
        const last = lastSentAt.get(key) || 0;
        if (Date.now() - last < throttleMs) return false;
        lastSentAt.set(key, Date.now());
    }
    const url = webhookUrl();
    if (!url) { console.warn(`[${ts()}] Slack未設定のため通知スキップ: ${text.slice(0, 80)}`); return false; }

    const body = JSON.stringify({ text: `${ICON[level] || ''} *EggCamera* (${HOST})\n${text}` });
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
