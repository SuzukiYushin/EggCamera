const express = require('express');
const path    = require('node:path');

const { CAPTURE_TIMEOUT_MS, COMPOSITED_DIR, R2_RETENTION_MS, ts } = require('../config');
const { sendTrigger, waitForNewRawFile, ensurePreviewJpeg } = require('../capture');
const { compositeForSession, uploadToR2, generateQRDataUrl } = require('../composite');
const { createSession, getSession, touch, registerPhoto, getPhoto } = require('../sessions');

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
    session.status   = 'compositing';
    session.error    = undefined;
    session.result   = undefined;

    res.status(202).json({ status: 'compositing' });

    (async () => {
        try {
            const photoEntry = getPhoto(photoId);
            const { fileName } = await compositeForSession(photoEntry.rawPath, frameId, session.id);
            await uploadToR2(path.join(COMPOSITED_DIR, fileName), fileName);
            const { dataUrl, targetUrl } = await generateQRDataUrl(fileName);

            session.result = {
                downloadUrl: targetUrl,
                qrDataUrl:   dataUrl,
                expiresAt:   Date.now() + R2_RETENTION_MS,
            };
            session.status = 'done';
        } catch (err) {
            console.error(`[${ts()}] select/composite failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
        }
    })();
});

module.exports = router;
