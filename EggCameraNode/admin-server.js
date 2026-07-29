// 管理(admin)専用プロセス（:3001）。撮影core(:3000)から障害分離する。
// ここがクラッシュ/暴走/過負荷になっても、core の撮影パスは止まらない。
// - 管理(運用)API（frames/settings/logs/diagnose/failed/notify/maintenance/restart）はローカルで処理
// - core密結合API（metrics/test-capture/chaos/selftest）と test-capture プレビュー(/api/photos)は core へプロキシ
const http    = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { ADMIN_PORT, PORT, ADMIN_DIR, FRAMES_DIR, ts } = require('./src/config');
const logger = require('./src/logger');
logger.install('admin'); // app.jsonl は core が書く。adminは読むだけ（writer指定しない）。

const adminRouter = require('./src/routes/admin');
const adminAuth = require('./src/routes/adminAuth');
const { errorBoundary } = require('./src/safe');

const app = express();

// ── 管理API レート制限 + 不審アクセス検知 ──────────────────────────────────
// 認証失敗ログを残す（brute-force 検知用）
app.use((req, res, next) => {
    const onFinish = () => {
        if (res.statusCode === 401) {
            console.warn(`[${ts()}] ⚠ admin 認証失敗: ${req.ip} ${req.method} ${req.path}`);
        }
    };
    res.on('finish', onFinish);
    next();
});
// フレーム画像(サムネ)の GET は「1画面の描画でまとめて十数件」飛ぶ性質のもので、
// 操作回数とは無関係。これを操作系と同じ枠で数えると、フレームを連続削除しただけで
// 枠を使い切り、以降の正当な操作や管理画面そのもの(/admin/)まで 429 になる
// （2026-07-29: 成長フレーム9件の連続削除で発生。削除自体は9件とも成功していた）。
// 画像は別枠の緩い上限に逃がし、操作/認証面は従来どおり上限で保護する。
const isFrameAsset = (req) => req.method === 'GET' && req.path.startsWith('/frames/');
const limitHandler = (kind) => (req, res) => {
    console.warn(`[${ts()}] ⚠ rate-limit: admin(${kind}) ${req.ip} ${req.path}`);
    res.status(429).json({ error: 'too_many_requests' });
};
// フレーム画像: 1IP あたり60秒に600回まで（読み取り専用の静的ファイル）
const assetLimiter = rateLimit({
    windowMs: 60 * 1000, max: 600,
    standardHeaders: true, legacyHeaders: false,
    skip: (req) => !isFrameAsset(req),
    handler: limitHandler('assets'),
});
// 操作・認証面: 1IP あたり60秒に180回まで（一括削除等のまとめ操作に耐える余裕を持たせつつ、
// Basic認証への総当たりは引き続きバウンドする）
const adminLimiter = rateLimit({
    windowMs: 60 * 1000, max: 180,
    standardHeaders: true, legacyHeaders: false,
    skip: isFrameAsset,
    handler: limitHandler('api'),
});
app.use(assetLimiter);
app.use(adminLimiter);

// core(:3000) へそのまま中継（ヘッダ=トークン含む・ボディはストリーム）
function proxyToCore(req, res) {
    const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
    const up = http.request({ host: '127.0.0.1', port: PORT, path: req.originalUrl, method: req.method, headers }, r => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'core_unreachable' }); });
    req.pipe(up);
}

// 撮影coreに密結合する管理API → core へ（express.json より前に raw ストリームで中継）
['/api/admin/metrics', '/api/admin/test-capture', '/api/admin/chaos', '/api/admin/chaos/client', '/api/admin/selftest']
    .forEach(p => app.all(p, proxyToCore));
// test-capture のプレビュー画像は core のセッションストアにあるので core から取る
app.use('/api/photos', proxyToCore);
// ライブビュー（MJPEG stream / 単写真 fallback / カメラ先行起動）も core へ中継。
// stream は1接続=1リクエストの長寿命ストリームで、proxyToCore が r.pipe(res) で素通しする。
app.use('/api/preview', proxyToCore);

// 管理(運用)API（ローカル処理）
app.use('/api/admin', adminRouter);

// フレーム画像（共有ファイル。管理画面のサムネ表示用）
// 一覧を描き直すたびに数MBのPNGを取り直さないよう短時間キャッシュする。追加/削除で
// ファイル名は変わるため、この程度の猶予で古い画像が見え続けることはない。
app.use('/frames', express.static(FRAMES_DIR, { maxAge: '60s' }));

// 管理画面の静的UI（Basic認証で保護＝開いた瞬間にブラウザのログインダイアログ）
app.use('/admin', adminAuth, express.static(ADMIN_DIR, {
    setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

app.use(errorBoundary);

// 既定では loopback のみに bind（管理APIをLANへ晒さない）。
// LAN公開が必要な場合のみ ADMIN_HOST=0.0.0.0 で明示的に上書きする。
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
app.listen(ADMIN_PORT, ADMIN_HOST, () => {
    console.log(`[${ts()}] EggCamera admin server listening on ${ADMIN_HOST}:${ADMIN_PORT} (core=:${PORT})`);
});

// admin が落ちても core に影響しない。ここではログのみ（launchd が再起動）。
process.on('uncaughtException',  err    => console.error(`[${ts()}] admin uncaughtException: ${err.stack || err.message}`));
process.on('unhandledRejection', reason => console.error(`[${ts()}] admin unhandledRejection: ${reason}`));
