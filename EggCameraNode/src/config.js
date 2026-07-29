require('dotenv').config();

const path = require('node:path');

// ── Paths ──────────────────────────────────────────────
// 既定は <repo>/data。env DATA_DIR で差し替え可能（ローカル検証用の別データディレクトリ等。
// 本番は未設定なので従来どおり）。配下の RAW/JOBS/FRAMES… はすべてこれを基準に派生する。
const DATA_DIR       = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname, '../../data');
const RAW_DIR        = path.join(DATA_DIR, 'raw');
const PREVIEW_DIR    = path.join(RAW_DIR, '.preview');
const COMPOSITED_DIR = path.join(DATA_DIR, 'composited');
// 後追いアップロード中(pending)と、1時間で諦めた失敗画像(failed)の保管先。
// COMPOSITED_DIR のトリム(30件)で消えないよう別ディレクトリに退避する。
const DEFERRED_DIR   = path.join(DATA_DIR, 'deferred');
const FAILED_DIR     = path.join(DATA_DIR, 'failed');
// サーバ側合成の永続ジョブ。1ジョブ=1ディレクトリ(job.json + 元写真 + composite.jpg)。
// in-memory セッションと分離し、再起動後も未完了の合成/アップロードを再開できるようにする。
const JOBS_DIR       = path.join(DATA_DIR, 'jobs');
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

// サーバ合成ジョブ: 未確定(プレビュー合成のみで決定タップされず放置)を掃除するTTL。
const JOB_PENDING_TTL_MS = 30 * 60 * 1000; // 30分
// アップロード/合成が成功するまでの再試行バックオフ（上限5分）。
const JOB_RETRY_DELAYS_MS = [0, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000];
// 失敗ジョブのライフサイクル（確定 confirmedAt 起点）:
//   ・確定から JOB_AUTO_RETRY_MS(24h) までは自動リトライを継続する。
//   ・24h で完了しなければ自動リトライを止め「要対応」として一覧に残す（手動救済待ち）。
//   ・確定から JOB_HARD_TTL_MS(48h) で、未完了でもファイルごと自動削除する。
const JOB_AUTO_RETRY_MS = 24 * 60 * 60 * 1000; // 24時間
const JOB_HARD_TTL_MS   = 48 * 60 * 60 * 1000; // 48時間

// サーバ側合成フロー(/compose・/confirm)を有効化するフラグ。
// 未設定(=0)ならクライアントは従来の canvas 合成(/composite)を使う。
// 切替/ロールバックは .env のこの値＋再起動だけで行える（クライアント再ビルド不要）。
const SERVER_COMPOSITE = process.env.SERVER_COMPOSITE === '1';

// 管理画面/管理APIの認証トークン（未設定なら認証なし＝従来どおり）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// 管理画面の Basic 認証（ブラウザのログインダイアログ）。
// user=ADMIN_USER（既定 admin）/ pass=ADMIN_PASSWORD（未設定なら ADMIN_TOKEN を流用）。
// 既存の X-Admin-Token ヘッダ / ?token= はテスト・iPad 用に後方互換で残す。
const ADMIN_USER     = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ADMIN_TOKEN;

// 管理画面からの再起動操作に要求するパスワード。
// セキュリティ上、既定値はコードに一切持たない（env .env のみ。人が手入力する想定）。
// 未設定なら再起動APIは fail-closed で全拒否する（src/routes/admin.js 参照）。
const REBOOT_PASSWORD = process.env.REBOOT_PASSWORD || '';

// 遠隔公開（取引先テスト）用の共有シークレット。Cloudflare(Pages Functions)経由のみで要求する。
// CF-Connecting-IP があるリクエスト（=Tunnel/Pages 経由）に限り X-EC-Proxy-Secret が
// この値と一致しなければ 403。未設定なら検証しない（＝従来どおり）。
// ローカル直叩き(iPad/テスト)は CF ヘッダが無いので常に素通り＝現行運用に無影響。
const PROXY_SECRET = process.env.PROXY_SECRET || '';

// ── Server ─────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
// 管理(admin)を別プロセス(:3001)に分離。撮影core(:3000)が落ちない/落とさないための障害分離。
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3001', 10);
const STATIC_DIR = process.env.STATIC_DIR
    ? path.resolve(process.env.STATIC_DIR)
    : path.resolve(__dirname, '../../EggCameraUserUI/dist');

// ── Session config ──────────────────────────────────────
const SESSION_TTL_MS    = parseInt(process.env.SESSION_TTL_MS    || '1800000', 10); // 30分
const CAPTURE_TIMEOUT_MS = parseInt(process.env.CAPTURE_TIMEOUT_MS || '25000', 10); // 25秒

// ── Trigger config ─────────────────────────────────────
const SWIFT_HOST = process.env.SWIFT_HOST || 'localhost';
const SWIFT_PORT = parseInt(process.env.SWIFT_PORT || '8082', 10);

// ── iPhone 接続（USB設計）: iproxy が localhost:8080 を iPhone:8080 へ転送 ──
// プレビュー/wake/死活確認はすべてこの1箇所を参照する（IPの直書きを禁止）。
const IPHONE_HOST = process.env.IPHONE_HOST || '127.0.0.1';
const IPHONE_PORT = parseInt(process.env.IPHONE_PORT || '8080', 10);
const IPHONE_FRAME_URL = process.env.IPHONE_FRAME_URL || `http://${IPHONE_HOST}:${IPHONE_PORT}/frame`;

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
    DATA_DIR, RAW_DIR, PREVIEW_DIR, COMPOSITED_DIR, DEFERRED_DIR, FAILED_DIR, JOBS_DIR,
    FRAMES_DIR, FLAME_PATH,
    FRAMES_META, FRAMES_TRASH, SETTINGS_PATH, LOG_DIR, ADMIN_DIR,
    MAX_COMPOSITED, MAX_RAW, LOG_RETAIN_DAYS, DISK_WARN_BYTES, DEFERRED_MAX_MS,
    JOB_PENDING_TTL_MS, JOB_RETRY_DELAYS_MS, JOB_AUTO_RETRY_MS, JOB_HARD_TTL_MS,
    SERVER_COMPOSITE,
    ADMIN_TOKEN, ADMIN_USER, ADMIN_PASSWORD, REBOOT_PASSWORD, PROXY_SECRET,
    PORT, ADMIN_PORT, STATIC_DIR,
    SESSION_TTL_MS, CAPTURE_TIMEOUT_MS,
    SWIFT_HOST, SWIFT_PORT,
    IPHONE_HOST, IPHONE_PORT, IPHONE_FRAME_URL,
    R2_RETENTION_MS, R2_CLEANUP_INTERVAL,
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
    PAGES_BASE_URL,
    ts,
};
