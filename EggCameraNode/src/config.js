require('dotenv').config();

const path = require('node:path');

// ── Paths ──────────────────────────────────────────────
const DATA_DIR       = path.resolve(__dirname, '../../data');
const RAW_DIR        = path.join(DATA_DIR, 'raw');
const PREVIEW_DIR    = path.join(RAW_DIR, '.preview');
const COMPOSITED_DIR = path.join(DATA_DIR, 'composited');
const FRAMES_DIR     = path.join(DATA_DIR, 'assets/frames');
const FLAME_PATH     = path.join(FRAMES_DIR, 'flame_sample.png');

const MAX_COMPOSITED = 30;

// ── Server ─────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const STATIC_DIR = process.env.STATIC_DIR
    ? path.resolve(process.env.STATIC_DIR)
    : path.resolve(__dirname, '../../EggCameraUserUI/dist');

// ── Session config ──────────────────────────────────────
const SESSION_TTL_MS    = parseInt(process.env.SESSION_TTL_MS    || '1800000', 10); // 30分
const CAPTURE_TIMEOUT_MS = parseInt(process.env.CAPTURE_TIMEOUT_MS || '25000', 10); // 25秒

// ── Trigger config ─────────────────────────────────────
const SWIFT_HOST = process.env.SWIFT_HOST || 'localhost';
const SWIFT_PORT = parseInt(process.env.SWIFT_PORT || '8082', 10);

// ── R2 config ──────────────────────────────────────────
const R2_RETENTION_MS     = 3 * 60 * 1000;   // 3分（検証用。本番は 3 * 24 * 60 * 60 * 1000）
const R2_CLEANUP_INTERVAL = 60 * 60 * 1000;  // 1時間ごと

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET            = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_BASE_URL   = process.env.R2_PUBLIC_BASE_URL;
const PAGES_BASE_URL       = process.env.PAGES_BASE_URL;

function ts() {
    return new Date().toISOString();
}

module.exports = {
    DATA_DIR, RAW_DIR, PREVIEW_DIR, COMPOSITED_DIR, FRAMES_DIR, FLAME_PATH,
    MAX_COMPOSITED,
    PORT, STATIC_DIR,
    SESSION_TTL_MS, CAPTURE_TIMEOUT_MS,
    SWIFT_HOST, SWIFT_PORT,
    R2_RETENTION_MS, R2_CLEANUP_INTERVAL,
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
    PAGES_BASE_URL,
    ts,
};
