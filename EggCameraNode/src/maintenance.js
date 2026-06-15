const fs   = require('node:fs');
const path = require('node:path');

const {
    DATA_DIR, RAW_DIR, PREVIEW_DIR, LOG_DIR,
    MAX_RAW, LOG_RETAIN_DAYS, DISK_WARN_BYTES,
    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, ts,
} = require('./config');
const { trimLocalDir } = require('./composite');
const slack = require('./slack');
const { safeInterval } = require('./safe');

// data/raw のHEICとプレビューを保持枚数まで間引く（無制限増加を防ぐ）
function trimRaw() {
    trimLocalDir(RAW_DIR, MAX_RAW);
    trimLocalDir(PREVIEW_DIR, MAX_RAW);
}

// 古いログファイルを削除
function trimLogs() {
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 86400_000;
    let files;
    try { files = fs.readdirSync(LOG_DIR).filter(f => /\.log$/.test(f)); } catch { return; }
    for (const f of files) {
        const p = path.join(LOG_DIR, f);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p); } catch { /* ignore */ }
    }
}

// ディスク空きが閾値を切ったらSlack警告（1時間に1回）
function checkDisk() {
    fs.statfs(DATA_DIR, (err, st) => {
        if (err) return;
        const free = st.bavail * st.bsize;
        if (free < DISK_WARN_BYTES) {
            const gb = (free / 1024 / 1024 / 1024).toFixed(1);
            console.warn(`[${ts()}] low disk: ${gb}GB free`);
            slack.notify(`ディスク空きが ${gb}GB を切りました。撮影が止まる前に整理してください。`,
                { level: 'alert', key: 'low-disk', throttleMs: 60 * 60_000 });
        }
    });
}

// 起動時のセルフチェック: 必須設定の不備を即検知して通知
function startupSelfCheck() {
    const missing = [];
    if (!R2_ACCESS_KEY_ID)     missing.push('R2_ACCESS_KEY_ID');
    if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!R2_BUCKET)            missing.push('R2_BUCKET_NAME');
    if (missing.length) {
        const msg = `起動時チェック: 必須設定が未設定です → ${missing.join(', ')}。アップロードが失敗します。`;
        console.error(`[${ts()}] ${msg}`);
        slack.notify(msg, { level: 'alert', key: 'startup-config', throttleMs: 60 * 60_000 });
        return false;
    }
    console.log(`[${ts()}] startup self-check OK`);
    return true;
}

// 定期保守をまとめて起動（サーバから呼ぶ）
function start() {
    startupSelfCheck();
    const run = () => { trimRaw(); trimLogs(); checkDisk(); };
    try { run(); } catch (e) { console.error(`[${ts()}] maintenance run failed: ${e.message}`); }
    safeInterval(run, 30 * 60_000, 'maintenance'); // 30分ごと（例外でプロセスを倒さない）
}

module.exports = { start, trimRaw, trimLogs, checkDisk, startupSelfCheck };
