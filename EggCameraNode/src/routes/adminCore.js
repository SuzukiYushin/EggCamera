// 撮影core(:3000)に残す管理エンドポイント。
// これらは core のプロセス状態に密結合するため admin(:3001) には置けない:
//   metrics … このcoreプロセスのメモリ/負荷
//   test-capture … 撮影パイプラインを叩き、core のセッションストアに写真登録
//   chaos … core の撮影パスが consume する注入状態（長期運用テスト用）
//   selftest … 撮影→合成→アップの自己診断（core の撮影パイプライン）
// admin(:3001) はこれらを core へプロキシする（admin-server.js）。
// 長期運用テスト拡張は従来どおり :3000/api/admin/{chaos,metrics} を直接叩ける。
const os      = require('node:os');
const path    = require('node:path');
const express = require('express');

const { CAPTURE_TIMEOUT_MS, ts } = require('../config');
const adminAuth = require('./adminAuth');
const { ensurePreviewJpeg } = require('../capture');
const camera = require('../adapters/camera');
const { registerPhoto } = require('../sessions');
const chaos    = require('../chaos');
const mode     = require('../mode');
const selftest = require('../selftest');

const router = express.Router();
router.use(express.json());
router.use(adminAuth);

// ── プロセス/マシンのメトリクス（このcoreプロセス） ──
router.get('/metrics', (req, res) => {
    const m = process.memoryUsage();
    res.json({
        rssMB:      +(m.rss / 1048576).toFixed(1),
        heapMB:     +(m.heapUsed / 1048576).toFixed(1),
        uptimeSec:  Math.round(process.uptime()),
        loadavg:    os.loadavg().map(n => +n.toFixed(2)),
        freeMemMB:  Math.round(os.freemem() / 1048576),
    });
});

// ── テスト撮影（1枚撮ってプレビューURLを返す） ──
router.post('/test-capture', async (req, res) => {
    try {
        const { rawPath } = await camera.capture(CAPTURE_TIMEOUT_MS);
        const previewPath = await ensurePreviewJpeg(rawPath);
        const photoId     = registerPhoto(rawPath, previewPath);
        console.log(`[${ts()}] test capture ok → ${path.basename(rawPath)}`);
        res.json({ photoId, url: `/api/photos/${photoId}` });
    } catch (err) {
        console.error(`[${ts()}] test capture failed: ${err.message}`);
        const code = err.message === 'mac-unreachable' ? 502
            : err.message === 'capture-timeout' ? 504 : 500;
        res.status(code).json({ error: err.message });
    }
});

// ── フォールトインジェクション（長期運用テスト用） ──
router.post('/chaos', (req, res) => {
    const { target, count } = req.body || {};
    if (!chaos.arm(target, count || 1)) return res.status(400).json({ error: 'invalid_target' });
    res.json(chaos.status());
});
router.get('/chaos', (req, res) => res.json(chaos.status()));
router.delete('/chaos', (req, res) => { chaos.reset(); res.json(chaos.status()); });

// クライアント(ページ内 hook)注入フォルトの予告窓。ハーネスが hook 注入時に立て、
// incident が hook 由来の致命エラー(createSession/capture/compose/confirm/js)を
// 「テスト注入(info)」と判定できるようにする（サーバを通らない hook 注入の誤⚠️抑止）。
router.post('/chaos/client', (req, res) => {
    chaos.expectClient((req.body && req.body.label) || 'client-hook');
    res.json(chaos.status());
});
router.delete('/chaos/client', (req, res) => { chaos.clearClientExpect(); res.json(chaos.status()); });

// ── 今すぐセルフテスト（撮影→合成→アップの自己診断） ──
router.post('/selftest', (req, res) => {
    mode.startMaintenance({ reason: (req.body && req.body.reason) || 'selftest' });
    res.json({ started: true });
    // 再起動系フローからの自己診断。合格でキオスクを自動再開する（手動 /egg ok は失敗時のみ）。
    selftest.run({ reason: (req.body && req.body.reason) || '', autoResumeOnPass: true }).catch(() => {});
});

module.exports = router;
