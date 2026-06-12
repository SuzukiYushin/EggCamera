const crypto = require('node:crypto');
const { SESSION_TTL_MS, ts } = require('./config');

// sessionId -> Session
const sessions = new Map();

// photoId -> { rawPath, previewPath }
const photoIndex = new Map();

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

function createSession() {
    const id = newId();
    const now = Date.now();
    const session = {
        id,
        status: 'idle',
        photos: [],
        selectedPhotoId: undefined,
        nickname: undefined,
        days: undefined,
        result: undefined,
        error: undefined,
        createdAt: now,
        lastTouchedAt: now,
    };
    sessions.set(id, session);
    return session;
}

function getSession(id) {
    return sessions.get(id);
}

function touch(session) {
    session.lastTouchedAt = Date.now();
}

function registerPhoto(rawPath, previewPath) {
    const photoId = newId();
    photoIndex.set(photoId, { rawPath, previewPath });
    return photoId;
}

function getPhoto(photoId) {
    return photoIndex.get(photoId);
}

function cleanupExpiredSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
        if (session.lastTouchedAt < cutoff) {
            sessions.delete(id);
            for (const photo of session.photos) {
                photoIndex.delete(photo.photoId);
            }
            console.log(`[${ts()}] session expired → ${id}`);
        }
    }
}

module.exports = {
    createSession,
    getSession,
    touch,
    registerPhoto,
    getPhoto,
    cleanupExpiredSessions,
};
