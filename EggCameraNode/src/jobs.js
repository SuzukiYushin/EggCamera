// ── サーバ側合成の永続ジョブストア（Phase 2） ─────────────────────────────
// 1ジョブ = data/jobs/<jobId>/ の1ディレクトリ。in-memory セッションと分離し、
// 再起動後も未完了の合成/アップロードを再開できるよう、状態とパラメータと
// 元写真をディスクに自己完結で保持する。
//
// status の遷移:
//   composed_pending  … /compose 済（composite.jpg あり）・決定待ち。未確定でTTL掃除対象
//   queued            … /confirm 済・アップロード待ち（worker が拾う）
//   composing         … worker が（再）合成中
//   composite_failed  … 直近の合成試行が失敗（worker が再試行し続ける）
//   uploading         … worker がアップロード中
//   upload_failed     … 直近のアップロードが失敗（worker が再試行し続ける）
//   done              … アップロード完了（uploadedAt 記録・uploadedAt+24Hで削除）
const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JOBS_DIR, ts } = require('./config');

fs.mkdirSync(JOBS_DIR, { recursive: true });

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

function jobDir(jobId)        { return path.join(JOBS_DIR, jobId); }
function jobJsonPath(jobId)   { return path.join(jobDir(jobId), 'job.json'); }
function compositePath(jobId) { return path.join(jobDir(jobId), 'composite.jpg'); }

// 安全な書き込み（tmp→rename）。途中クラッシュで job.json を半端にしない。
function writeJobJson(job) {
    const dir = jobDir(job.jobId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `job.json.tmp_${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, jobJsonPath(job.jobId));
    return job;
}

// ── 新規ジョブ作成（/compose で呼ぶ）。元写真を複製し composite を保存する ──
// opts: { sessionId, fileName, capturedAt, frameId, frameFile, crop,
//         nickname, days, daysText, sourcePath, compositeBuffer }
function createJob(opts) {
    const jobId = newId();
    const dir = jobDir(jobId);
    fs.mkdirSync(dir, { recursive: true });

    // 元写真を複製（raw トリム・再起動・再合成に耐える自己完結化）
    let sourceFile = null;
    try {
        if (opts.sourcePath && fs.existsSync(opts.sourcePath)) {
            sourceFile = `source${path.extname(opts.sourcePath).toLowerCase() || '.heic'}`;
            fs.copyFileSync(opts.sourcePath, path.join(dir, sourceFile));
        }
    } catch (err) {
        console.error(`[${ts()}] job ${jobId}: source copy failed: ${err.message}`);
    }

    if (opts.compositeBuffer) {
        fs.writeFileSync(compositePath(jobId), opts.compositeBuffer);
    }

    const now = Date.now();
    const job = {
        jobId,
        sessionId:  opts.sessionId || null,
        fileName:   opts.fileName,
        capturedAt: opts.capturedAt || now,
        frameId:    opts.frameId || null,
        frameFile:  opts.frameFile || null,
        crop:       opts.crop || { zoom: 1, offsetX: 0, offsetY: 0 },
        nickname:   opts.nickname || '',
        days:       opts.days || 0,
        daysText:   opts.daysText || '',
        sourceFile,
        status:     opts.compositeBuffer ? 'composed_pending' : 'composing',
        attempts:   0,
        lastError:  null,
        result:     null,            // { downloadUrl, qrDataUrl, expiresAt }
        listedFailedAt: null,        // 滞留として管理画面失敗一覧に出した時刻
        createdAt:   now,
        confirmedAt: null,
        uploadedAt:  null,
        updatedAt:   now,
    };
    return writeJobJson(job);
}

function readJob(jobId) {
    try {
        return JSON.parse(fs.readFileSync(jobJsonPath(jobId), 'utf8'));
    } catch {
        return null;
    }
}

// 部分更新（read→merge→atomic write）。worker と /confirm から呼ぶ。
function updateJob(jobId, patch) {
    const cur = readJob(jobId);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    return writeJobJson(next);
}

function listJobs() {
    let ids;
    try { ids = fs.readdirSync(JOBS_DIR); } catch { return []; }
    const out = [];
    for (const id of ids) {
        if (id.startsWith('.')) continue;
        const job = readJob(id);
        if (job) out.push(job);
    }
    return out;
}

function deleteJob(jobId) {
    try { fs.rmSync(jobDir(jobId), { recursive: true, force: true }); } catch { /* ignore */ }
}

function sourcePathOf(job) {
    if (!job.sourceFile) return null;
    const p = path.join(jobDir(job.jobId), job.sourceFile);
    return fs.existsSync(p) ? p : null;
}

module.exports = {
    createJob, readJob, updateJob, listJobs, deleteJob,
    jobDir, compositePath, sourcePathOf, newId,
};
