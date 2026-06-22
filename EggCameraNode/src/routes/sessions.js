const express = require('express');
const path    = require('node:path');

const { CAPTURE_TIMEOUT_MS, COMPOSITED_DIR, R2_RETENTION_MS, ts } = require('../config');
const { ensurePreviewJpeg } = require('../capture');
const camera = require('../adapters/camera');
const { saveComposite, uploadToR2, deferredUploadToR2, generateQRDataUrl } = require('../composite');
const { createSession, getSession, touch, registerPhoto } = require('../sessions');
const chaos = require('../chaos');

const router = express.Router();

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
