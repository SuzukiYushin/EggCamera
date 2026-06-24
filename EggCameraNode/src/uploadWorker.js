// ── サーバ合成ジョブの永続 worker（Phase 2） ──────────────────────────────
// queued/未完了ジョブを逐次処理（合成→アップロード→done）。タイムアウト無しで
// 成功するまでバックオフ再試行。起動時に data/jobs を走査して未完了を再開する。
// 完了ジョブは uploadedAt+24H でローカル削除（R2 は cleanupOldR2Objects が別途削除）。
const fs   = require('node:fs');
const path = require('node:path');
const {
    FRAMES_DIR, FLAME_PATH, R2_RETENTION_MS, DEFERRED_MAX_MS,
    JOB_PENDING_TTL_MS, JOB_RETRY_DELAYS_MS, ts,
} = require('./config');
const jobsStore = require('./jobs');
const { composeFinalImage } = require('./compose');
const { uploadToR2 } = require('./composite');
const chaos = require('./chaos');
const sse   = require('./sse');
const slack = require('./slack');

// ── 逐次キュー（sharp.concurrency=1 に合わせ同時1ジョブ） ──
const queue = new Set();
let running = false;

function broadcast(job) {
    try { sse.broadcast('job-changed', { jobId: job.jobId, status: job.status, fileName: job.fileName }); }
    catch { /* SSE失敗は無視 */ }
}

function resolveFramePath(frameFile) {
    if (frameFile) {
        const p = path.join(FRAMES_DIR, frameFile);
        if (fs.existsSync(p)) return p;
    }
    return FLAME_PATH;
}

function enqueue(jobId) {
    queue.add(jobId);
    pump();
}

function pump() {
    if (running) return;
    const next = queue.values().next();
    if (next.done) return;
    const jobId = next.value;
    queue.delete(jobId);
    running = true;
    processOne(jobId)
        .catch(err => console.error(`[${ts()}] job ${jobId}: worker error ${err.message}`))
        .finally(() => { running = false; if (queue.size) setImmediate(pump); });
}

function scheduleRetry(jobId, attempts) {
    const delay = JOB_RETRY_DELAYS_MS[Math.min(attempts, JOB_RETRY_DELAYS_MS.length - 1)];
    setTimeout(() => enqueue(jobId), delay).unref?.();
}

// 確定から一定時間（1h）成功しないジョブを「失敗一覧」相当として表面化＋Slack
function maybeListOverdue(job) {
    if (job.listedFailedAt) return;
    const since = job.confirmedAt || job.createdAt;
    if (Date.now() - since < DEFERRED_MAX_MS) return;
    jobsStore.updateJob(job.jobId, { listedFailedAt: Date.now() });
    const failing = listFailedJobs().length;
    slack.notify(
        `完成画像のアップロード/合成が1時間成功していません（現在 ${failing} 件）。`
        + `管理画面の失敗一覧で状況確認・手動DLしてください。`,
        { level: 'warn', key: 'jobs-overdue', throttleMs: 15 * 60_000 });
}

function fail(jobId, status, err) {
    const cur = jobsStore.readJob(jobId);
    if (!cur) return;
    const job = jobsStore.updateJob(jobId, {
        status, lastError: String(err && err.message || err).slice(0, 300),
        attempts: (cur.attempts || 0) + 1,
    });
    console.warn(`[${ts()}] job ${jobId}: ${status} (attempt ${job.attempts}): ${job.lastError}`);
    broadcast(job);
    maybeListOverdue(job);
    scheduleRetry(jobId, job.attempts);
}

async function processOne(jobId) {
    const job = jobsStore.readJob(jobId);
    if (!job) return;                 // 掃除済み等
    if (job.status === 'done') return;
    if (job.status === 'composed_pending') return; // 未確定はアップロードしない

    // 1) composite.jpg が無ければ params から再合成（再起動/破損/未合成に耐える）
    if (!fs.existsSync(jobsStore.compositePath(jobId))) {
        broadcast(jobsStore.updateJob(jobId, { status: 'composing' }));
        try {
            const src = jobsStore.sourcePathOf(job);
            if (!src) throw new Error('source_missing');
            const { buffer } = await composeFinalImage({
                sourcePath: src,
                framePath:  resolveFramePath(job.frameFile),
                crop:       job.crop,
                nickname:   job.nickname,
                daysText:   job.daysText,
            });
            fs.writeFileSync(jobsStore.compositePath(jobId), buffer);
            console.log(`[${ts()}] job ${jobId}: (re)composited → ${job.fileName}`);
        } catch (err) {
            return fail(jobId, 'composite_failed', err);
        }
    }

    // 2) R2 アップロード
    broadcast(jobsStore.updateJob(jobId, { status: 'uploading' }));
    try {
        if (chaos.consume('r2')) throw new Error('injected_r2_failure');
        await uploadToR2(jobsStore.compositePath(jobId), job.fileName);
    } catch (err) {
        return fail(jobId, 'upload_failed', err);
    }

    // 3) 完了
    const uploadedAt = Date.now();
    const done = jobsStore.updateJob(jobId, {
        status: 'done', uploadedAt, lastError: null, listedFailedAt: null,
        result: { ...(job.result || {}), expiresAt: uploadedAt + R2_RETENTION_MS },
    });
    console.log(`[${ts()}] job ${jobId}: done → ${job.fileName} (uploadedAt=${new Date(uploadedAt).toISOString()})`);
    broadcast(done);
}

// ── 失敗/滞留ジョブの一覧（管理画面 Phase 4 用） ──
function listFailedJobs() {
    return jobsStore.listJobs()
        .filter(j => j.status !== 'done' && j.status !== 'composed_pending')
        .filter(j => j.listedFailedAt || (Date.now() - (j.confirmedAt || j.createdAt) >= DEFERRED_MAX_MS))
        .sort((a, b) => (b.confirmedAt || b.createdAt) - (a.confirmedAt || a.createdAt));
}

// ── 起動時に未完了ジョブを再開（再起動耐性の中核） ──
function resumeAll() {
    const all = jobsStore.listJobs();
    let resumed = 0, swept = 0;
    for (const job of all) {
        if (job.status === 'done') continue;
        if (job.status === 'composed_pending') {
            // 未確定プレビュー: 再起動でセッションは消えており確定不能 → 掃除
            jobsStore.deleteJob(job.jobId); swept++; continue;
        }
        enqueue(job.jobId); resumed++;
    }
    if (resumed || swept) {
        console.log(`[${ts()}] upload-worker resume: ${resumed} job(s) requeued, ${swept} pending swept`);
    }
}

// ── 定期掃除: 完了は uploadedAt+24H、未確定は TTL で削除 ──
function sweep() {
    const now = Date.now();
    for (const job of jobsStore.listJobs()) {
        if (job.status === 'done' && job.uploadedAt && now > job.uploadedAt + R2_RETENTION_MS) {
            jobsStore.deleteJob(job.jobId);
            console.log(`[${ts()}] job ${job.jobId}: swept (uploadedAt+24H) → ${job.fileName}`);
        } else if (job.status === 'composed_pending' && now > job.createdAt + JOB_PENDING_TTL_MS) {
            jobsStore.deleteJob(job.jobId);
            console.log(`[${ts()}] job ${job.jobId}: swept (unconfirmed TTL)`);
        }
    }
}

module.exports = { enqueue, resumeAll, sweep, listFailedJobs };
