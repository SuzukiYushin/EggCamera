require('dotenv').config();

const path = require('node:path');

// ── Paths ──────────────────────────────────────────────
const DATA_DIR       = path.resolve(__dirname, '../../data');
const RAW_DIR        = path.join(DATA_DIR, 'raw');
const PREVIEW_DIR    = path.join(RAW_DIR, '.preview');
const COMPOSITED_DIR = path.join(DATA_DIR, 'composited');
// 後追いアップロード中(pending)と、1時間で諦めた失敗画像(failed)の保管先。
// COMPOSITED_DIR のトリム(30件)で消えないよう別ディレクトリに退避する。
const DEFERRED_DIR   = path.join(DATA_DIR, 'deferred');
const FAILED_DIR     = path.join(DATA_DIR, 'failed');
const FRAMES_DIR     = path.join(DATA_DIR, 'assets/frames');
const FLAME_PATH     = path.join(FRAMES_DIR, 'flame_sample.png');
const FRAMES_META    = path.join(FRAMES_DIR, 'frames.json');
const FRAMES_TRASH   = path.join(FRAMES_DIR, '.trash');
const SETTINGS_PATH  = path.join(DATA_DIR, 'settings.json');
const LOG_DIR        = path.join(DATA_DIR, 'logs');
const ADMIN_DIR      = path.resolve(__dirname, '../admin');

const MAX_COMPOSITED = 30;
const MAX_RAW        = 60;   // data/raw のHEIC保持枚数（無制限増加を防ぐ）
const LOG_RETAIN_DAYS = 14;  // data/logs の保持日数

// ディスク空きがこれを下回ったらSlack警告
const DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

// 後追いアップロードをこの時間まで粘り、超えたら failed として管理画面に出す
const DEFERRED_MAX_MS = 60 * 60 * 1000; // 1時間

// 管理画面/管理APIの認証トークン（未設定なら認証なし＝従来どおり）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// 管理画面からの再起動操作に要求するパスワード
const REBOOT_PASSWORD = process.env.REBOOT_PASSWORD || 'familiar1234';

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
const R2_RETENTION_MS     = 24 * 60 * 60 * 1000; // 24時間保持
const R2_CLEANUP_INTERVAL = 3 * 60 * 60 * 1000;  // 3時間ごとにまとめて削除

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
    DATA_DIR, RAW_DIR, PREVIEW_DIR, COMPOSITED_DIR, DEFERRED_DIR, FAILED_DIR,
    FRAMES_DIR, FLAME_PATH,
    FRAMES_META, FRAMES_TRASH, SETTINGS_PATH, LOG_DIR, ADMIN_DIR,
    MAX_COMPOSITED, MAX_RAW, LOG_RETAIN_DAYS, DISK_WARN_BYTES, DEFERRED_MAX_MS,
    ADMIN_TOKEN, REBOOT_PASSWORD,
    PORT, STATIC_DIR,
    SESSION_TTL_MS, CAPTURE_TIMEOUT_MS,
    SWIFT_HOST, SWIFT_PORT,
    R2_RETENTION_MS, R2_CLEANUP_INTERVAL,
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
    PAGES_BASE_URL,
    ts,
};
