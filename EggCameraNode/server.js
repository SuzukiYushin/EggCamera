const path    = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit; // IPv6 を /56 に正規化するヘルパ（per-IP キーの IPv6 対策）

const { PORT, STATIC_DIR, FRAMES_DIR, ADMIN_DIR, R2_CLEANUP_INTERVAL, SESSION_TTL_MS, SERVER_COMPOSITE, PROXY_SECRET, ts } = require('./src/config');
const logger = require('./src/logger');
logger.install();

const { cleanupOldR2Objects } = require('./src/composite');
const { cleanupExpiredSessions } = require('./src/sessions');
const uploadWorker = require('./src/uploadWorker');
const slack = require('./src/slack');
const frames   = require('./src/frames');
const settings = require('./src/settings');
const preview  = require('./src/preview');
const sse      = require('./src/sse');
const maintenance = require('./src/maintenance');
const mode        = require('./src/mode');
const selftest    = require('./src/selftest');
const sessionsRouter = require('./src/routes/sessions');
const photosRouter   = require('./src/routes/photos');
const adminCoreRouter = require('./src/routes/adminCore'); // 撮影coreに密結合する管理API(metrics/test-capture/chaos/selftest)のみ
const { errorBoundary, safeInterval, safeTimeout } = require('./src/safe');

const app = express();

// ── 遠隔公開ゲート（層2）: Cloudflare(Pages Functions)経由のみ共有シークレットを要求 ──
// 取引先テスト用に api.siggaze.com を Tunnel 公開する際、Pages Functions が付与する
// X-EC-Proxy-Secret を検証する。CF-Connecting-IP があるリクエスト（=Cloudflare 経由）に
// 限り判定し、PROXY_SECRET 未設定なら無効（従来どおり）。ローカル直叩き(iPad/同一LAN/テスト)は
// CF ヘッダが無いので常に素通り＝現行運用に無影響。撮影coreへの影響を避けるため最前段で軽量判定。
if (PROXY_SECRET) {
    app.use((req, res, next) => {
        if (req.headers['cf-connecting-ip'] &&
            req.headers['x-ec-proxy-secret'] !== PROXY_SECRET) {
            return res.status(403).json({ error: 'forbidden' });
        }
        next();
    });
}

app.use(express.json());

// ── レート制限 ───────────────────────────────────────────────────────────────
// セッション作成: DoS対策（1IP あたり60秒に20回まで）
// ── レート制限のキー（per-IP 化） ──
// cloudflared トンネル経由では接続元が常に 127.0.0.1 になり、req.ip だと全インターネット
// 流入が1バケツに合算される（per-IP にならない＝正常時は詰まりやすく、攻撃には弱い）。
// Cloudflare が付与する CF-Connecting-IP（トンネル経由なら詐称困難）を鍵にして per-IP 化する。
// ローカル直叩き（テスト/同一LANのiPad）は CF ヘッダが無いので req.ip にフォールバック。
const clientIp = (req) =>
    ipKeyGenerator(String(req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown'));
// 自前でキーを生成するため、express-rate-limit のプロキシ系バリデーションは無効化する。
const RL_VALIDATE = { trustProxy: false, xForwardedForHeader: false };

const sessionLimiter = rateLimit({
    windowMs: 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: clientIp, validate: RL_VALIDATE,
    handler: (req, res) => {
        console.warn(`[${ts()}] rate-limit: sessions ${clientIp(req)}`);
        res.status(429).json({ error: 'too_many_requests' });
    },
});

// プレビューは高頻度だが低コスト（node 側キャッシュ・読み取り専用）。公開上限から「除外」して
// 穴にするのではなく、専用の緩い上限でバウンドする（DoS 保護を残しつつ 3〜8fps では詰まらない）。
// MJPEG(/preview/stream) は1接続=1リクエスト、フォールバックの単写真(/preview/frame)は ~3fps。
const previewLimiter = rateLimit({
    windowMs: 60 * 1000, max: 600,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: clientIp, validate: RL_VALIDATE,
    handler: (req, res) => {
        console.warn(`[${ts()}] rate-limit: preview ${clientIp(req)} ${req.path}`);
        res.status(429).json({ error: 'too_many_requests' });
    },
});

// 公開API全体: 1IP あたり60秒に200回まで（重い/状態変更系の DoS 対策）。
// プレビュー(/preview/*)は previewLimiter が別枠でバウンドするので、ここでは二重計上を避けるため
// skip する（= 保護ゼロではなく別枠で保護）。一方で /client-log（ログ書き込み＝肥大リスク）と
// /events(SSE)・/mode は 1接続/低頻度で 200回内に収まるため、あえて除外せず本上限で保護する。
// 注: app.use('/api', ...) 配下では req.path はマウント相対（'/preview/frame' 等）になる。
const PREVIEW_SKIP = ['/preview/stream', '/preview/frame', '/preview/wake'];
const publicLimiter = rateLimit({
    windowMs: 60 * 1000, max: 200,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: clientIp, validate: RL_VALIDATE,
    skip: (req) => PREVIEW_SKIP.includes(req.path),
    handler: (req, res) => {
        console.warn(`[${ts()}] rate-limit: public ${clientIp(req)} ${req.path}`);
        res.status(429).json({ error: 'too_many_requests' });
    },
});
app.use('/api/sessions', sessionLimiter);
app.use('/api/preview', previewLimiter);
app.use('/api', publicLimiter);

app.use('/api/sessions', sessionsRouter);
app.use('/api/photos', photosRouter);
// 管理APIのうち撮影coreに密結合する分だけ core が直接持つ（残りは admin:3001）。
// 長期運用テスト拡張は従来どおり :3000/api/admin/{chaos,metrics} を直接叩ける。
app.use('/api/admin', adminCoreRouter);

// ── ユーザーUI向け公開API: 使用中フレーム一覧とクロップ設定 ──
app.get('/api/frames', (req, res) => {
    res.json(frames.listActiveFrames().map(f => ({ id: f.id, name: f.name, url: `/frames/${f.file}` })));
});
app.get('/api/settings', (req, res) => res.json(settings.getSettings()));

// ── SSE: 管理画面の設定変更をiPadへリアルタイムプッシュ ──
app.get('/api/events', (req, res) => sse.addClient(res));

// ── 内部トリガー: admin プロセスが設定保存後にここを叩く（localhost のみ） ──
app.post('/api/internal/reload-signal', (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' &&
        req.socket.remoteAddress !== '::ffff:127.0.0.1') {
        return res.status(403).end();
    }
    sse.broadcast('settings-changed');
    console.log(`[${ts()}] reload-signal broadcast to ${sse.clientCount()} SSE client(s)`);
    res.json({ ok: true, clients: sse.clientCount() });
});

// ── ユーザーUIが参照する運用モード（メンテ中は操作ロック / 合成方式フラグ） ──
app.get('/api/mode', (req, res) => res.json({
    maintenance: mode.isMaintenance(),
    serverCompose: SERVER_COMPOSITE,
}));

// ── iPhone ライブプレビュー ──
// stream: MJPEG(multipart/x-mixed-replace)。node 側の単一取得ループを全クライアントへ fan-out。
// frame : 単写真(後方互換 / MJPEG非対応ブラウザの fallback)。同じ取得ループのキャッシュを返す。
// どちらも iPhone:8080 への取得は単一ループ1本に集約される（視聴者数と無関係に一定）。
app.get('/api/preview/stream', (req, res) => preview.streamFrames(req, res));
app.get('/api/preview/frame', (req, res) => preview.proxyFrame(req, res));

// ── iPhone カメラ先行起動（iPad のスタート押下時に呼ぶ。撮影ページの待ち時間軽減） ──
app.post('/api/preview/wake', (req, res) => res.json({ ok: preview.wake() }));

// ── フロントのエラー詳細をサーバログへ集約（オーバーレイの原因調査用） ──
app.post('/api/client-log', (req, res) => {
    const { message = '', screen = '' } = req.body || {};
    console.error(`[${ts()}] [CLIENT${screen ? `:${screen}` : ''}] ${String(message).slice(0, 2000)}`);
    res.json({ ok: true });
});

// ── 長期運用テスト拡張からの判定・サマリをサーバログへ集約 ──
// 拡張の検知結果(想定外/コスト警告/停滞/DL失敗など)は本来ブラウザ内にしか
// 残らないため、ここへ送ってもらい data/logs/ に記録する（Claudeの監視用）。
app.post('/api/test-report', (req, res) => {
    const { level = 'info', text = '' } = req.body || {};
    const line = `[${ts()}] [TEST] ${String(text).slice(0, 2000)}`;
    if (level === 'alert') console.error(line);
    else console.log(line);
    res.json({ ok: true });
});

// フレーム画像本体（.trash はドットディレクトリなので配信されない）
app.use('/frames', express.static(FRAMES_DIR));

// 管理画面(静的UI)は admin 別プロセス(:3001)が配信する（障害分離のため core では持たない）。

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

// ── エラーバウンダリ（必ず最後）: どのルートの例外もここで500化し、プロセス継続 ──
app.use(errorBoundary);

preview.startDiscovery();
maintenance.start(); // 起動セルフチェック + raw/log保持 + ディスク監視
cleanupOldR2Objects();
// バックグラウンドジョブは safeInterval で包む（1ジョブの例外で全停止しない）
safeInterval(cleanupOldR2Objects, R2_CLEANUP_INTERVAL, 'r2-cleanup');
safeInterval(cleanupExpiredSessions, Math.min(SESSION_TTL_MS, 5 * 60 * 1000), 'session-cleanup');

// サーバ合成ジョブ: 起動時に未完了を再開（再起動耐性）＋ 5分ごとに掃除（完了24H/未確定TTL）
uploadWorker.resumeAll();
safeInterval(uploadWorker.sweep, 5 * 60 * 1000, 'jobs-sweep');

// ── 5分ごとに自プロセスのメモリ/負荷をログへ（リーク・フリーズ予兆の追跡） ──
const os = require('node:os');
safeInterval(() => {
    const m = process.memoryUsage();
    console.log(`[${ts()}] metrics: rss=${(m.rss / 1048576).toFixed(0)}MB ` +
        `heap=${(m.heapUsed / 1048576).toFixed(0)}MB load=${os.loadavg()[0].toFixed(2)} ` +
        `freemem=${(os.freemem() / 1073741824).toFixed(1)}GB`);
}, 5 * 60 * 1000, 'metrics');

// 想定外のクラッシュ要因は人力対応が要るので Slack 通知（ログに残してプロセスは継続）
process.on('uncaughtException', err => {
    console.error(`[${ts()}] uncaughtException: ${err.stack || err.message}`);
    slack.notify(`サーバで未捕捉エラーが発生しました: ${err.message}`,
        { level: 'alert', key: 'uncaught', throttleMs: 5 * 60_000 });
});
process.on('unhandledRejection', reason => {
    console.error(`[${ts()}] unhandledRejection: ${reason}`);
    slack.notify(`サーバで未処理のPromise拒否: ${String(reason).slice(0, 200)}`,
        { level: 'alert', key: 'unhandled', throttleMs: 5 * 60_000 });
});

const server = app.listen(PORT, () => {
    console.log(`[${ts()}] EggCameraNode listening on :${PORT} (static: ${STATIC_DIR})`);
    // Mac本体リブート等でbot自身が落ちた場合の保険: 起動時フラグがあればセルフテスト
    if (mode.get().runSelfTestOnBoot) {
        mode.clearSelfTestFlag();
        safeTimeout(() => selftest.run({ reason: '再起動後（起動時自動）' }), 8000, 'boot-selftest');
    }
});

// グレースフルシャットダウン: 受付を止めて処理中リクエストを捌いてから終了
let shuttingDown = false;
function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${ts()}] ${sig} received → graceful shutdown`);
    server.close(() => { console.log(`[${ts()}] closed`); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref(); // 念のため上限
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
