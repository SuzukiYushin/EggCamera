// ── サーバ合成ジョブの永続 worker（Phase 2） ──────────────────────────────
// queued/未完了ジョブを逐次処理（合成→アップロード→done）。タイムアウト無しで
// 成功するまでバックオフ再試行。起動時に data/jobs を走査して未完了を再開する。
// 完了ジョブは uploadedAt+24H でローカル削除（R2 は cleanupOldR2Objects が別途削除）。
const fs   = require('node:fs');
const path = require('node:path');
const {
    FRAMES_DIR, FLAME_PATH, R2_RETENTION_MS, DEFERRED_MAX_MS,
    JOB_PENDING_TTL_MS, JOB_RETRY_DELAYS_MS, JOB_AUTO_RETRY_MS, JOB_HARD_TTL_MS, ts,
} = require('./config');
const jobsStore = require('./jobs');
const { composeInChild } = require('./compose');
const { uploadToR2, r2ObjectExists } = require('./composite');
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

function scheduleRetry(jobId) {
    const job = jobsStore.readJob(jobId);
    if (!job) return;
    // 手動救済（再送/再合成）中は worker の自動リトライを止める（二重実行防止）。
    if (job.manualLock) return;
    // 確定から24hを超えたら自動リトライを止め「要対応」化する（48hで sweep が削除）。
    const since = job.confirmedAt || job.createdAt;
    if (Date.now() - since >= JOB_AUTO_RETRY_MS) {
        if (!job.attentionRequired) {
            jobsStore.updateJob(jobId, { attentionRequired: true, autoStoppedAt: Date.now() });
            console.warn(`[${ts()}] job ${jobId}: auto-retry stopped after 24h → needs manual attention`);
            slack.notify(
                `完成画像のアップロード/合成が24時間成功しませんでした。自動リトライを停止しました。`
                + `管理画面の「失敗画像」で再送/再合成してください（あと24時間で自動削除）。`,
                { level: 'alert', key: 'job-attention', throttleMs: 30 * 60_000 });
        }
        return;
    }
    const delay = JOB_RETRY_DELAYS_MS[Math.min(job.attempts || 0, JOB_RETRY_DELAYS_MS.length - 1)];
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
    scheduleRetry(jobId);
}

async function processOne(jobId) {
    const job = jobsStore.readJob(jobId);
    if (!job) return;                 // 掃除済み等
    if (job.status === 'done') return;
    // 未確定（客が決定していない）はアップロードしない。composed_pending だけでなく、
    // compose 失敗やクラッシュで 'composing' のまま残った孤児も confirmedAt が無い＝ここで止める
    // （素通りすると客が決定していない写真を再合成→R2 アップロードしてしまう）。
    if (!job.confirmedAt) return;
    if (job.manualLock) return; // 手動救済中（再送/再合成）は worker は触らない＝二重実行防止

    // 1) composite.jpg が無ければ params から再合成（再起動/破損/未合成に耐える）
    if (!fs.existsSync(jobsStore.compositePath(jobId))) {
        broadcast(jobsStore.updateJob(jobId, { status: 'composing' }));
        try {
            const src = jobsStore.sourcePathOf(job);
            if (!src) throw new Error('source_missing');
            await composeInChild({
                sourcePath: src,
                framePath:  resolveFramePath(job.frameFile),
                crop:       job.crop,
                nickname:   job.nickname,
                daysText:   job.daysText,
                outPath:    jobsStore.compositePath(jobId),
                dlPreviewPath: jobsStore.dlPreviewPath(jobId),
            });
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

    // 2.5) DLページ先行表示用の縮小版（あれば）。本画像の後に上げる＝preview が R2 に
    // 在る時は必ず本画像も在る、を保証する（DLページはこの順序に依存）。
    // 失敗してもジョブは完了扱い（DLページは preview 無しでも従来どおり動く）。
    const pvPath = jobsStore.dlPreviewPath(jobId);
    if (fs.existsSync(pvPath)) {
        const pvKey = job.fileName.replace(/\.jpg$/i, '_preview.jpg');
        try { await uploadToR2(pvPath, pvKey); }
        catch (err) { console.warn(`[${ts()}] job ${jobId}: dl-preview upload failed (non-fatal): ${err.message}`); }
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
        if (!job.confirmedAt) {
            // 未確定（composed_pending / composing 孤児）: 再起動でセッションは消えており
            // 確定不能 → 掃除。'composing' のまま残った失敗残骸を requeue すると
            // 客が決定していない写真をアップロードしてしまうため、状態でなく confirmedAt で判定する。
            jobsStore.deleteJob(job.jobId); swept++; continue;
        }
        // 再起動でブラウザ保持の blob/presign は失われるため、手動ロックは解除して自動へ戻す
        if (job.manualLock) {
            jobsStore.updateJob(job.jobId, { manualLock: false, manualMode: null });
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
        } else if (!job.confirmedAt && job.status !== 'done') {
            // 未確定（composed_pending / composing 孤児）: 客の決定が無いまま TTL 超過なら静かに削除。
            // 48h 枝に落とすと「48時間アップロード/合成できず」の誤アラート（客が確定していない
            // job への alert）を発報してしまうため、確定済みだけを 48h 枝で扱う。
            if (now > job.createdAt + JOB_PENDING_TTL_MS) {
                jobsStore.deleteJob(job.jobId);
                console.log(`[${ts()}] job ${job.jobId}: swept (unconfirmed TTL)`);
            }
        } else if (job.status !== 'done') {
            // 失敗/滞留系: 確定から48h(=deleteAfter)で、自動も手動も完了しなかったものを削除。
            const base = job.confirmedAt || job.createdAt;
            const hardTtl = job.deleteAfter || (base + JOB_HARD_TTL_MS);
            if (now > hardTtl) {
                jobsStore.deleteJob(job.jobId);
                console.warn(`[${ts()}] job ${job.jobId}: swept (confirmedAt+48H, never completed) → ${job.fileName}`);
                slack.notify(
                    `写真 ${job.fileName} を48時間アップロード/合成できず自動削除しました。`,
                    { level: 'alert', key: `job-deleted-${job.jobId}`, throttleMs: 60 * 60_000 });
            }
        }
    }
}

// ── 手動救済（管理画面の直R2アップロード）の完了をHEADで確認して done 化 ──────
// ブラウザがネット切替後でサーバへ完了通知できなくても、ここでR2の実在を確認して
// done に到達させる（complete API は即時反映用の従経路）。manualLock のジョブのみ対象。
async function checkManualUploads() {
    for (const job of jobsStore.listJobs()) {
        if (!job.manualLock || job.status === 'done') continue;
        // 期限切れロック（presign 発行後スタッフが操作を放棄）は解除して自動リトライへ戻す。
        // ここで enqueue しないと再開契機が無く、node 再起動か 48h 削除まで停滞する。
        if (job.manualLockUntil && Date.now() > job.manualLockUntil) {
            jobsStore.updateJob(job.jobId, { manualLock: false, manualMode: null });
            console.log(`[${ts()}] job ${job.jobId}: manual lock expired → auto retry resumed`);
            enqueue(job.jobId);
            continue;
        }
        let exists = false;
        try { exists = await r2ObjectExists(job.fileName); } catch { exists = false; }
        if (!exists) continue;
        const done = jobsStore.markManualDone(job.jobId);
        if (done) {
            console.log(`[${ts()}] job ${job.jobId}: manual upload confirmed via R2 HEAD → done`);
            broadcast(done);
        }
    }
}

module.exports = { enqueue, resumeAll, sweep, checkManualUploads, listFailedJobs };
