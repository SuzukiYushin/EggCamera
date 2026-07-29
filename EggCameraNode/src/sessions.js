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
        inFlight: 0, // 撮影中(await camera.capture 待ち)の枚数。3枚キャップを枚数+inFlightで同期判定するため
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

// 実撮影(await camera.capture 待ち)が進行中のセッションがあるか。
// warmup(捨て撮り)を実客の撮影に割り込ませないためのガードに使う
// （同時撮影は sendTrigger が待つ新規rawを取り違えうるため）。
function anyCapturing() {
    for (const s of sessions.values()) {
        if (s.inFlight > 0 || s.status === 'capturing') return true;
    }
    return false;
}

// 実撮影の最終開始時刻。warmup(捨て撮り)が「自分の撮影中に実客の撮影が並走開始したか」を
// 事後判定するために使う（anyCapturing だけだと、warmup の capture 中に実客撮影が
// 開始→完了まで済んだケースを取りこぼす）。
let lastCaptureStartAt = 0;
function markCaptureStart() { lastCaptureStartAt = Date.now(); }
function lastCaptureStart() { return lastCaptureStartAt; }

// 生存中(未期限)セッションが保持する raw/preview の絶対パス集合。
// 孤児raw GC が「まだ参照されている実ファイル」を誤って消さないために使う。
function listReferencedRawPaths() {
    const set = new Set();
    for (const { rawPath, previewPath } of photoIndex.values()) {
        if (rawPath) set.add(rawPath);
        if (previewPath) set.add(previewPath);
    }
    return set;
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
    anyCapturing,
    markCaptureStart,
    lastCaptureStart,
    listReferencedRawPaths,
    cleanupExpiredSessions,
};
