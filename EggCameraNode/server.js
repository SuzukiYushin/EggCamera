const path    = require('node:path');
const express = require('express');

const { PORT, STATIC_DIR, FRAMES_DIR, ADMIN_DIR, R2_CLEANUP_INTERVAL, SESSION_TTL_MS, ts } = require('./src/config');
const logger = require('./src/logger');
logger.install();

const { cleanupOldR2Objects } = require('./src/composite');
const { cleanupExpiredSessions } = require('./src/sessions');
const slack = require('./src/slack');
const frames   = require('./src/frames');
const settings = require('./src/settings');
const preview  = require('./src/preview');
const maintenance = require('./src/maintenance');
const mode        = require('./src/mode');
const selftest    = require('./src/selftest');
const sessionsRouter = require('./src/routes/sessions');
const photosRouter   = require('./src/routes/photos');
const adminRouter    = require('./src/routes/admin');

const app = express();
app.use(express.json());

app.use('/api/sessions', sessionsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/admin', adminRouter);

// ── ユーザーUI向け公開API: 使用中フレーム一覧とクロップ設定 ──
app.get('/api/frames', (req, res) => {
    res.json(frames.listActiveFrames().map(f => ({ id: f.id, name: f.name, url: `/frames/${f.file}` })));
});
app.get('/api/settings', (req, res) => res.json(settings.getSettings()));

// ── ユーザーUIが参照する運用モード（メンテ中は操作ロック） ──
app.get('/api/mode', (req, res) => res.json({ maintenance: mode.isMaintenance() }));

// ── iPhone ライブプレビュー（Bonjourで発見した iPhone:8080/frame を中継） ──
app.get('/api/preview/frame', (req, res) => preview.proxyFrame(req, res));

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

// ── 管理画面（同一LAN内のブラウザから /admin でアクセス） ──
app.use('/admin', express.static(ADMIN_DIR, {
    setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

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

preview.startDiscovery();
maintenance.start(); // 起動セルフチェック + raw/log保持 + ディスク監視
cleanupOldR2Objects();
setInterval(cleanupOldR2Objects, R2_CLEANUP_INTERVAL);
setInterval(cleanupExpiredSessions, Math.min(SESSION_TTL_MS, 5 * 60 * 1000));

// ── 5分ごとに自プロセスのメモリ/負荷をログへ（リーク・フリーズ予兆の追跡） ──
const os = require('node:os');
setInterval(() => {
    const m = process.memoryUsage();
    console.log(`[${ts()}] metrics: rss=${(m.rss / 1048576).toFixed(0)}MB ` +
        `heap=${(m.heapUsed / 1048576).toFixed(0)}MB load=${os.loadavg()[0].toFixed(2)} ` +
        `freemem=${(os.freemem() / 1073741824).toFixed(1)}GB`);
}, 5 * 60 * 1000);

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
        setTimeout(() => selftest.run({ reason: '再起動後（起動時自動）' }).catch(() => {}), 8000);
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
