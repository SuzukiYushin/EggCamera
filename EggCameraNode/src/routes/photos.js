const express = require('express');
const { getPhoto } = require('../sessions');

const router = express.Router();

// ── GET /api/photos/:photoId ────────────────────────────────────────────
router.get('/:photoId', (req, res) => {
    const photo = getPhoto(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'photo_not_found' });
    // dotfiles:'allow' — previewPath lives under data/raw/.preview/
    res.sendFile(photo.previewPath, { dotfiles: 'allow' });
});

module.exports = router;
