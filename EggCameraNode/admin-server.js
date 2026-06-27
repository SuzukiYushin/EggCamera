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
// 1IP あたり60秒に60回まで
const adminLimiter = rateLimit({
    windowMs: 60 * 1000, max: 60,
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => {
        console.warn(`[${ts()}] ⚠ rate-limit: admin ${req.ip} ${req.path}`);
        res.status(429).json({ error: 'too_many_requests' });
    },
});
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

// 管理(運用)API（ローカル処理）
app.use('/api/admin', adminRouter);

// フレーム画像（共有ファイル。管理画面のサムネ表示用）
app.use('/frames', express.static(FRAMES_DIR));

// 管理画面の静的UI（Basic認証で保護＝開いた瞬間にブラウザのログインダイアログ）
app.use('/admin', adminAuth, express.static(ADMIN_DIR, {
    setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

app.use(errorBoundary);

app.listen(ADMIN_PORT, () => {
    console.log(`[${ts()}] EggCamera admin server listening on :${ADMIN_PORT} (core=:${PORT})`);
});

// admin が落ちても core に影響しない。ここではログのみ（launchd が再起動）。
process.on('uncaughtException',  err    => console.error(`[${ts()}] admin uncaughtException: ${err.stack || err.message}`));
process.on('unhandledRejection', reason => console.error(`[${ts()}] admin unhandledRejection: ${reason}`));
