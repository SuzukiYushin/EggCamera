'use strict';
// インシデント状態の永続ストア。ユーザーUIは致命エラーやアップロード遅延時に
// location.reload() でリロードするため、フロントの useState では「連続で何回起きたか」を
// 跨いで数えられない。そこでサーバ側のファイルに連続カウントを保持する。
//
// 主用途: 系統B（アップロードがセッション終了までに完了しない）が「2セッション連続」で
// 起きたかの判定。1回成功（done）が挟まればリセットする。

const fs   = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ts } = require('./config');

const STATE_FILE = path.join(DATA_DIR, 'incident-state.json');

function load() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return { uploadStuckStreak: 0, lastJobId: null, updatedAt: 0 }; }
}

function save(s) {
    try {
        s.updatedAt = Date.now();
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, STATE_FILE);   // atomic
    } catch { /* ignore */ }
    return s;
}

function get() { return load(); }

// アップロード未解消セッションを1件記録し、連続回数を返す。
// 同じjobIdの二重報告は数えない（QR「トップ」とEndタイムアウトの両方で発火しても1回）。
function recordUploadStuck(jobId) {
    const s = load();
    if (jobId && s.lastJobId === jobId) return s.uploadStuckStreak; // 二重カウント防止
    s.uploadStuckStreak = (s.uploadStuckStreak || 0) + 1;
    s.lastJobId = jobId || null;
    save(s);
    console.log(`[${ts()}] incident: upload-stuck streak=${s.uploadStuckStreak} (job ${jobId || '-'})`);
    return s.uploadStuckStreak;
}

// アップロードが正常完了したセッション。連続カウントをリセットする。
function recordUploadOk(jobId) {
    const s = load();
    if (!s.uploadStuckStreak && s.lastJobId == null) return; // 既に0なら書き込み不要
    save({ uploadStuckStreak: 0, lastJobId: jobId || null });
    console.log(`[${ts()}] incident: upload-stuck streak reset (job ${jobId || '-'})`);
}

module.exports = { get, recordUploadStuck, recordUploadOk };
