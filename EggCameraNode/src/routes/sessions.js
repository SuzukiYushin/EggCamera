const express = require('express');
const path    = require('node:path');

const { CAPTURE_TIMEOUT_MS, COMPOSITED_DIR, R2_RETENTION_MS, FRAMES_DIR, FLAME_PATH, ts } = require('../config');
const { ensurePreviewJpeg } = require('../capture');
const camera = require('../adapters/camera');
const { saveComposite, uploadToR2, deferredUploadToR2, generateQRDataUrl } = require('../composite');
const { createSession, getSession, touch, registerPhoto, getPhoto } = require('../sessions');
const { composeFinalImage, makeThumbnailDataUrl } = require('../compose');
const jobsStore = require('../jobs');
const worker    = require('../uploadWorker');
const settings  = require('../settings');
const frames    = require('../frames');
const fs        = require('node:fs');
const chaos = require('../chaos');

const router = express.Router();

// ── 完成画像ファイル名（=DL ID）: familia_EggCamera_YYYY.MM.DD.HH.mm.ss[.jpg] ──
// 同一秒の衝突だけ _2,_3… を付ける（既存ジョブの fileName と突き合わせ）。
const PHOTO_PREFIX = 'familia_EggCamera';
function makeFileName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const base = `${PHOTO_PREFIX}_${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.`
        + `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    const existing = new Set(jobsStore.listJobs().map(j => j.fileName));
    let name = `${base}.jpg`;
    for (let i = 2; existing.has(name); i++) name = `${base}_${i}.jpg`;
    return name;
}

// 撮影日時: raw ファイル名 YYYYMMDD_HHMMSS から推定（無理なら mtime）。
function capturedAtOf(rawPath) {
    const m = path.basename(rawPath).match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (m) {
        const [, Y, Mo, D, H, Mi, S] = m;
        const t = new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime();
        if (!Number.isNaN(t)) return t;
    }
    try { return fs.statSync(rawPath).mtimeMs; } catch { return Date.now(); }
}

// 使用中フレームから1つ抽選（サーバ抽選）。0件ならサンプルにフォールバック。
function pickFrame() {
    const active = frames.listActiveFrames();
    if (active.length) {
        const f = active[Math.floor(Math.random() * active.length)];
        return { frameId: f.id, frameFile: f.file, framePath: path.join(FRAMES_DIR, f.file) };
    }
    return { frameId: null, frameFile: null, framePath: FLAME_PATH };
}

// ── POST /api/sessions ─────────────────────────────────────────────────
router.post('/', (req, res) => {
    const session = createSession();
    res.json({ sessionId: session.id });
});

// ── GET /api/sessions/:id ───────────────────────────────────────────────
router.get('/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    touch(session);
    res.json(session);
});

// ── POST /api/sessions/:id/capture ──────────────────────────────────────
router.post('/:id/capture', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    // 確定枚数＋撮影中(in-flight)で頭打ち判定。length だけだと await camera.capture() をまたぐ間に
    // 複数リクエストが >=3 チェックを同時通過し、連打時に4枚目のシャッターが漏れる。
    // Nodeは単一スレッドなので「判定→inFlight++」はawait前に同期実行され、ここで枠を予約してレースを塞ぐ。
    if (session.photos.length + session.inFlight >= 3) {
        return res.status(400).json({ error: 'max_shots_reached' });
    }
    session.inFlight += 1;

    touch(session);
    session.status = 'capturing';

    try {
        if (chaos.consume('capture')) throw new Error('mac-unreachable');
        const { rawPath } = await camera.capture(CAPTURE_TIMEOUT_MS);
        const previewPath = await ensurePreviewJpeg(rawPath);
        const photoId      = registerPhoto(rawPath, previewPath);
        const photo        = { photoId, url: `/api/photos/${photoId}` };

        session.photos.push(photo);
        session.status = session.photos.length >= 3 ? 'ready' : 'idle';
        res.json(photo);
    } catch (err) {
        session.status = 'idle';
        if (err.message === 'mac-unreachable') {
            return res.status(502).json({ error: 'mac_unreachable' });
        }
        if (err.message === 'capture-timeout') {
            return res.status(504).json({ error: 'capture_timeout' });
        }
        console.error(`[${ts()}] capture failed: ${err.message}`);
        return res.status(500).json({ error: 'capture_failed' });
    } finally {
        session.inFlight -= 1; // 成否に関わらず予約を解放
    }
});

// ── POST /api/sessions/:id/select ───────────────────────────────────────
// Records the user's choices; the actual final image is composited client-side
// and uploaded separately via POST /:id/composite.
router.post('/:id/select', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const { photoId, nickname, days } = req.body || {};
    const photo = session.photos.find(p => p.photoId === photoId);
    if (!photo) return res.status(400).json({ error: 'invalid_photo' });

    touch(session);
    session.selectedPhotoId = photoId;
    session.nickname = nickname;
    session.days     = days;

    res.json({ status: 'ok' });
});

// ── POST /api/sessions/:id/compose ──────────────────────────────────────
// サーバ側で最終画像を原寸合成し、永続ジョブ(composed_pending)として保存。
// プレビュー用のサムネ(dataURL)を返す。決定タップは別途 /confirm で行う。
// body: { photoId, nickname, daysText, days }
router.post('/:id/compose', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const { photoId, nickname = '', daysText = '', days = 0 } = req.body || {};
    const inSession = session.photos.find(p => p.photoId === photoId);
    const photo = inSession && getPhoto(photoId);
    if (!photo) return res.status(400).json({ error: 'invalid_photo' });

    touch(session);
    session.selectedPhotoId = photoId;
    session.nickname = nickname;
    session.days     = days;

    try {
        if (chaos.consume('compose')) throw new Error('injected_compose_failure');
        const crop = settings.getSettings().crop;
        const { frameId, frameFile, framePath } = pickFrame();
        const { buffer } = await composeFinalImage({
            sourcePath: photo.rawPath, framePath, crop, nickname, daysText,
        });

        const fileName = makeFileName();
        const job = jobsStore.createJob({
            sessionId: session.id, fileName, capturedAt: capturedAtOf(photo.rawPath),
            frameId, frameFile, crop, nickname, days, daysText,
            sourcePath: photo.rawPath, compositeBuffer: buffer,
        });
        session.composeJobId = job.jobId;

        const thumbDataUrl = await makeThumbnailDataUrl(buffer, 1080);
        res.json({ jobId: job.jobId, fileName, capturedAt: job.capturedAt, thumbDataUrl });
    } catch (err) {
        console.error(`[${ts()}] compose failed (session ${session.id}): ${err.message}`);
        res.status(500).json({ error: 'compose_failed' });
    }
});

// ── POST /api/sessions/:id/confirm ──────────────────────────────────────
// 決定タップ。直前の compose ジョブを確定→アップロード worker へ投入。
// QR はアップロード非依存に即発行して返す（アップロード中でもDL用QRを提示できる）。
router.post('/:id/confirm', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const jobId = (req.body && req.body.jobId) || session.composeJobId;
    const job = jobId && jobsStore.readJob(jobId);
    if (!job) return res.status(400).json({ error: 'no_composed_job' });

    touch(session);
    try {
        if (chaos.consume('qr')) throw new Error('injected_qr_failure');
        const { dataUrl, targetUrl } = await generateQRDataUrl(job.fileName);
        const result = {
            downloadUrl: targetUrl,
            qrDataUrl:   dataUrl,
            expiresAt:   Date.now() + R2_RETENTION_MS, // 確定時は概算。完了時に uploadedAt+24H へ更新
        };
        jobsStore.updateJob(jobId, { status: 'queued', confirmedAt: Date.now(), result });
        worker.enqueue(jobId);

        // 既存の status ポーリング(GET /sessions/:id)で QR を拾えるよう session にも反映
        session.result = result;
        session.status = 'done';

        res.status(202).json({ status: 'uploading', ...result });
    } catch (err) {
        console.error(`[${ts()}] confirm failed (session ${session.id}): ${err.message}`);
        res.status(500).json({ error: 'confirm_failed' });
    }
});

// ── POST /api/sessions/:id/composite ────────────────────────────────────
// Receives the final composited image (photo + frame + name/days, baked in
// the browser via canvas) as a raw PNG body, uploads it to R2, and generates
// the download QR.
router.post('/:id/composite', express.raw({ type: ['image/jpeg', 'image/png'], limit: '40mb' }), async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'invalid_image' });
    }

    touch(session);
    session.status = 'compositing';
    session.error  = undefined;
    session.result = undefined;

    res.status(202).json({ status: 'compositing' });

    (async () => {
        // ローカル保存は必須（失敗＝復旧不能なので従来どおりエラー）
        let fileName;
        try {
            ({ fileName } = await saveComposite(req.body));
        } catch (err) {
            console.error(`[${ts()}] composite save failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
            return;
        }
        const localPath = path.join(COMPOSITED_DIR, fileName);

        // 通常経路: R2へ即アップロード。成功すればそのままDL可能。
        let uploaded = false;
        try {
            if (chaos.consume('r2')) throw new Error('injected_r2_failure');
            await uploadToR2(localPath, fileName);
            uploaded = true;
        } catch (err) {
            // ★ 代替経路（不安定時のみ）: アップロードは諦めず後追いリトライに回す。
            console.warn(`[${ts()}] R2 upload failed (${err.message}); switching to deferred upload`);
        }

        // QRは想定URLで作れる（アップロード成否に依存しない）。
        // QR生成自体の失敗は通信と無関係なので、これは従来どおりエラー扱い。
        let dataUrl, targetUrl;
        try {
            if (chaos.consume('qr')) throw new Error('injected_qr_failure');
            ({ dataUrl, targetUrl } = await generateQRDataUrl(fileName));
        } catch (err) {
            console.error(`[${ts()}] QR generation failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
            return;
        }

        session.result = {
            downloadUrl: targetUrl,
            qrDataUrl:   dataUrl,
            expiresAt:   Date.now() + R2_RETENTION_MS,
            deferred:    !uploaded, // アップロードが後追いなら true（DLに時間差が出る）
        };
        session.status = 'done';

        // 後追いアップロードをバックグラウンドで開始。ユーザーは時間をおいてDLできる。
        if (!uploaded) {
            console.warn(`[${ts()}] deferred-upload mode → ${fileName} (QR shown immediately)`);
            deferredUploadToR2(localPath, fileName).catch(() => {});
        }
    })();
});

module.exports = router;
