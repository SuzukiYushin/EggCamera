const express = require('express');
const path    = require('node:path');

const { CAPTURE_TIMEOUT_MS, COMPOSITED_DIR, R2_RETENTION_MS, ts } = require('../config');
const { sendTrigger, waitForNewRawFile, ensurePreviewJpeg } = require('../capture');
const { saveComposite, uploadToR2, generateQRDataUrl } = require('../composite');
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
    if (session.photos.length >= 3) return res.status(400).json({ error: 'max_shots_reached' });

    touch(session);
    session.status = 'capturing';

    try {
        if (chaos.consume('capture')) throw new Error('mac-unreachable');
        const sinceMs = Date.now();
        await sendTrigger();
        const rawPath     = await waitForNewRawFile(sinceMs, CAPTURE_TIMEOUT_MS);
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
    }
});

// ── POST /api/sessions/:id/select ───────────────────────────────────────
// Records the user's choices; the actual final image is composited client-side
// and uploaded separately via POST /:id/composite.
router.post('/:id/select', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const { photoId, frameId, nickname, days } = req.body || {};
    const photo = session.photos.find(p => p.photoId === photoId);
    if (!photo) return res.status(400).json({ error: 'invalid_photo' });

    touch(session);
    session.selectedPhotoId = photoId;
    session.frameId  = frameId;
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
        try {
            const { fileName } = await saveComposite(req.body, session.id);
            if (chaos.consume('r2')) throw new Error('injected_r2_failure');
            await uploadToR2(path.join(COMPOSITED_DIR, fileName), fileName);
            if (chaos.consume('qr')) throw new Error('injected_qr_failure');
            const { dataUrl, targetUrl } = await generateQRDataUrl(fileName);

            session.result = {
                downloadUrl: targetUrl,
                qrDataUrl:   dataUrl,
                expiresAt:   Date.now() + R2_RETENTION_MS,
            };
            session.status = 'done';
        } catch (err) {
            console.error(`[${ts()}] composite upload failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
        }
    })();
});

module.exports = router;
