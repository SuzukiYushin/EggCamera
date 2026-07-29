const fs   = require('node:fs');
const path = require('node:path');

const {
    DATA_DIR, RAW_DIR, PREVIEW_DIR, LOG_DIR,
    MAX_RAW, LOG_RETAIN_DAYS, DISK_WARN_BYTES,
    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, ts,
} = require('./config');
const { trimLocalDir } = require('./composite');
const { listReferencedRawPaths } = require('./sessions');
const slack = require('./slack');
const { safeInterval } = require('./safe');

// data/raw に入り得る撮影画像の拡張子（HEIC含む。trimLocalDir は png/jpg しか見ないため
// HEIC の孤児はこちらで回収する）。
const RAW_FILE_RE = /\.(heic|heif|jpg|jpeg|png)$/i;
// 孤児raw GC: 未参照の raw/preview をこの時間より古い場合のみ削除する。生存セッションの raw は
// photoIndex で参照され続けるので対象外（＝撮影直後・登録前のレース保護にもなる）。
const ORPHAN_RAW_TTL_MS = 10 * 60 * 1000; // 10分

// data/raw のHEICとプレビューを保持枚数まで間引く（無制限増加を防ぐ）
function trimRaw() {
    trimLocalDir(RAW_DIR, MAX_RAW);
    trimLocalDir(PREVIEW_DIR, MAX_RAW);
}

// 孤児raw GC: どの生存セッションからも参照されない古い raw/preview を削除する。
// 撮影シーケンス進行中にページがリロードされるとセッションが放棄され、合成に使われない
// 余分な1枚（孤児raw）が data/raw に残る。枚数キャップ(trimRaw)とは別に、参照の有無＋
// 経過時間で精密に回収する（参照中＝生存セッション保持中、または新しすぎる＝撮影直後の
// 登録前レースは残す）。
function sweepOrphanRaws() {
    const referenced = listReferencedRawPaths();
    const cutoff = Date.now() - ORPHAN_RAW_TTL_MS;
    let removed = 0;
    for (const dir of [RAW_DIR, PREVIEW_DIR]) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isFile() || !RAW_FILE_RE.test(e.name)) continue;
            const full = path.join(dir, e.name);
            if (referenced.has(full)) continue;       // 生存/未期限セッションが保持中 → 残す
            let mtime;
            try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
            if (mtime >= cutoff) continue;            // 新しすぎる（登録前レース保護）→ 残す
            try { fs.rmSync(full); removed++; } catch { /* ignore */ }
        }
    }
    if (removed) console.log(`[${ts()}] orphan raw sweep: removed ${removed} file(s)`);
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
                { level: 'alert', action: 'restart', key: 'low-disk', throttleMs: 60 * 60_000 });
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
        slack.notify(msg, { level: 'alert', action: 'fix', key: 'startup-config', throttleMs: 60 * 60_000 });
        return false;
    }
    console.log(`[${ts()}] startup self-check OK`);
    return true;
}

// 定期保守をまとめて起動（サーバから呼ぶ）
function start() {
    startupSelfCheck();
    const run = () => { trimRaw(); sweepOrphanRaws(); trimLogs(); checkDisk(); };
    try { run(); } catch (e) { console.error(`[${ts()}] maintenance run failed: ${e.message}`); }
    safeInterval(run, 30 * 60_000, 'maintenance'); // 30分ごと（例外でプロセスを倒さない）
}

module.exports = { start, trimRaw, sweepOrphanRaws, trimLogs, checkDisk, startupSelfCheck };
