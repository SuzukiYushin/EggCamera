const path    = require('node:path');
const express = require('express');

const { PORT, STATIC_DIR, R2_CLEANUP_INTERVAL, SESSION_TTL_MS, ts } = require('./src/config');
const { cleanupOldR2Objects } = require('./src/composite');
const { cleanupExpiredSessions } = require('./src/sessions');
const sessionsRouter = require('./src/routes/sessions');
const photosRouter   = require('./src/routes/photos');

const app = express();
app.use(express.json());

app.use('/api/sessions', sessionsRouter);
app.use('/api/photos', photosRouter);

// Serve the built kiosk UI, with an SPA fallback for client-side routes.
// index.html must never be cached (it references content-hashed bundle
// filenames) — otherwise iOS Safari keeps serving a stale build after deploys.
app.use(express.static(STATIC_DIR, {
    setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-store');
        }
    },
}));
app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

cleanupOldR2Objects();
setInterval(cleanupOldR2Objects, R2_CLEANUP_INTERVAL);
setInterval(cleanupExpiredSessions, Math.min(SESSION_TTL_MS, 5 * 60 * 1000));

app.listen(PORT, () => {
    console.log(`[${ts()}] EggCameraNode listening on :${PORT} (static: ${STATIC_DIR})`);
});
