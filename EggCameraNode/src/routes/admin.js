const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const express = require('express');

const { DATA_DIR, FAILED_DIR, CAPTURE_TIMEOUT_MS, ADMIN_TOKEN, REBOOT_PASSWORD, ts } = require('../config');
const { diagnose } = require('../diagnose');
const ops = require('../ops');
const { ensurePreviewJpeg } = require('../capture');
const camera = require('../adapters/camera');
const { registerPhoto } = require('../sessions');
const { listFailedUploads, retryFailedUpload } = require('../composite');
const frames   = require('../frames');
const settings = require('../settings');
const logger   = require('../logger');
const chaos    = require('../chaos');
const slack    = require('../slack');
const mode     = require('../mode');
const selftest = require('../selftest');

const router = express.Router();
router.use(express.json());

// ADMIN_TOKEN を設定すると管理APIに認証が要る（未設定なら従来どおり素通り）。
// ヘッダ X-Admin-Token か ?token= で渡す。
router.use((req, res, next) => {
    if (!ADMIN_TOKEN) return next();
    const tok = req.get('X-Admin-Token') || req.query.token;
    if (tok === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'unauthorized' });
});

const HOME = os.homedir();

function frameToJson(f) {
    return { ...f, url: `/frames/${f.file}` };
}

// ── フレーム一覧 ────────────────────────────────────────────────────────
router.get('/frames', (req, res) => {
    res.json(frames.listFrames().map(frameToJson));
});

// ── フレーム追加（ブラウザのPCローカルから: 画像バイナリを直接POST） ──────
router.post('/frames',
    express.raw({ type: ['image/png', 'image/jpeg'], limit: '30mb' }),
    (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ error: 'invalid_image' });
        }
        const ext  = req.get('Content-Type') === 'image/jpeg' ? '.jpg' : '.png';
        const name = decodeURIComponent(req.get('X-Frame-Name') || '');
        try {
            res.json(frameToJson(frames.addFrameFromBuffer(req.body, name, ext)));
        } catch (err) {
            console.error(`[${ts()}] frame add failed: ${err.message}`);
            res.status(400).json({ error: err.message });
        }
    });

// ── フレーム追加（Mac mini ローカルのファイルパスから） ───────────────────
router.post('/frames/from-server', (req, res) => {
    const { path: srcPath, name } = req.body || {};
    const resolved = path.resolve(srcPath || '');
    if (!resolved.startsWith(HOME)) {
        return res.status(400).json({ error: 'path_outside_home' });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return res.status(400).json({ error: 'file_not_found' });
    }
    try {
        res.json(frameToJson(frames.addFrameFromPath(resolved, name)));
    } catch (err) {
        console.error(`[${ts()}] frame add (server) failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// ── Mac mini ローカルのディレクトリ閲覧（ホーム以下に制限） ────────────────
router.get('/browse', (req, res) => {
    const dir = path.resolve(req.query.dir || HOME);
    if (!dir.startsWith(HOME)) return res.status(400).json({ error: 'path_outside_home' });
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return res.status(400).json({ error: 'dir_not_readable' });
    }
    const dirs = [];
    const files = [];
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else if (/\.(png|jpe?g)$/i.test(e.name)) files.push(e.name);
    }
    dirs.sort(); files.sort();
    res.json({ dir, parent: dir === HOME ? null : path.dirname(dir), dirs, files });
});

// ── フレーム削除（一覧から外すだけ。実ファイルは .trash に残る） ───────────
router.delete('/frames/:id', (req, res) => {
    try {
        res.json(frameToJson(frames.deleteFrame(req.params.id)));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ── 使用中/非表示の切り替え ───────────────────────────────────────────────
router.patch('/frames/:id', (req, res) => {
    try {
        res.json(frameToJson(frames.setFrameActive(req.params.id, req.body?.active)));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ── HDD 空き容量 ─────────────────────────────────────────────────────────
router.get('/disk', (req, res) => {
    fs.statfs(DATA_DIR, (err, st) => {
        if (err) return res.status(500).json({ error: 'statfs_failed' });
        const total = st.blocks * st.bsize;
        const free  = st.bavail * st.bsize;
        res.json({ totalBytes: total, freeBytes: free, usedBytes: total - free });
    });
});

// ── プロセス/マシンのメトリクス（メモリリーク・過負荷の監視用） ────────────
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

// ── テスト撮影（セッション不要・1枚だけ撮ってプレビューURLを返す） ─────────
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

// ── クロップ設定 ─────────────────────────────────────────────────────────
router.get('/settings', (req, res) => res.json(settings.getSettings()));
router.put('/settings', (req, res) => res.json(settings.saveSettings(req.body)));

// ── ログ（リングバッファ） ────────────────────────────────────────────────
router.get('/logs', (req, res) => {
    const since = parseInt(req.query.since || '0', 10) || 0;
    res.json(logger.getLogs(since));
});

// ── フォールトインジェクション（長期運用テスト用） ─────────────────────────
// POST {target: 'capture'|'r2'|'qr', count} → 次の count 回だけわざと失敗させる
router.post('/chaos', (req, res) => {
    const { target, count } = req.body || {};
    if (!chaos.arm(target, count || 1)) {
        return res.status(400).json({ error: 'invalid_target' });
    }
    res.json(chaos.status());
});
router.get('/chaos', (req, res) => res.json(chaos.status()));
router.delete('/chaos', (req, res) => { chaos.reset(); res.json(chaos.status()); });

// ── 失敗画像（1時間アップできなかったもの） ────────────────────────────────
router.get('/failed', (req, res) => {
    res.json(listFailedUploads().map(f => ({
        fileName: f.fileName,
        failedAt: f.failedAt,
        url: `/api/admin/failed/${encodeURIComponent(f.fileName)}`,
    })));
});

// 画像本体（管理画面のサムネ表示＆ダウンロード）
router.get('/failed/:file', (req, res) => {
    const name = path.basename(req.params.file); // パストラバーサル防止
    const p = path.join(FAILED_DIR, name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not_found' });
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.sendFile(p);
});

// 手動で再アップロード（成功したら一覧から消える）
router.post('/failed/:file/retry', async (req, res) => {
    try {
        await retryFailedUpload(path.basename(req.params.file));
        res.json({ ok: true });
    } catch (err) {
        const code = err.message === 'not_found' ? 404 : 502;
        res.status(code).json({ error: err.message });
    }
});

// 一覧から削除（ローカルの失敗ファイルを破棄）
router.delete('/failed/:file', (req, res) => {
    const p = path.join(FAILED_DIR, path.basename(req.params.file));
    try { fs.rmSync(p); res.json({ ok: true }); }
    catch { res.status(404).json({ error: 'not_found' }); }
});

// ── Slack 通知（監視ループ/エージェントからのバグ修正・人力対応報告用） ───
// POST {text, kind?: 'fix'|'warn'|'alert'|'info'}
router.post('/notify', (req, res) => {
    const { text, kind } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text_required' });
    const level = ['fix', 'warn', 'alert', 'info'].includes(kind) ? kind : 'info';
    const sent = slack.notify(text.slice(0, 1500), { level });
    res.json({ ok: true, sent });
});

// ── メンテナンス（ユーザー操作ロック）＋ 再起動後セルフテスト ─────────────
router.get('/maintenance', (req, res) => res.json(mode.get()));

// 開始: キオスクUIをロック。runSelfTestOnBoot=true で次回node起動時に自動テスト
router.post('/maintenance/start', (req, res) => {
    res.json(mode.startMaintenance(req.body || {}));
});

// 解除: ユーザー操作を再開（Slackの「OK」に相当）
router.post('/maintenance/stop', (req, res) => {
    res.json(mode.stopMaintenance());
});

// 今すぐセルフテストを実行（node稼働中の再起動の後にBotが呼ぶ）。
// 実行前にロックし、完了後もロックは維持（解除は /maintenance/stop）。
router.post('/selftest', (req, res) => {
    mode.startMaintenance({ reason: (req.body && req.body.reason) || 'selftest' });
    res.json({ started: true });
    selftest.run({ reason: (req.body && req.body.reason) || '' }).catch(() => {});
});

// ── 再起動タブ: 診断＋パスワード保護の再起動 ─────────────────────────────
// どの対象を再起動すべきかをログから推定
router.get('/diagnose', (req, res) => res.json(diagnose()));

// 再起動実行（パスワード必須）。target = iphone|mac|node|iphone-reboot|iphone-refresh|mac-reboot
router.post('/restart/:target', async (req, res) => {
    if ((req.body && req.body.password) !== REBOOT_PASSWORD) {
        return res.status(401).json({ error: 'bad_password' });
    }
    try {
        const result = await ops.restart(req.params.target);
        res.json(result);
    } catch (err) {
        console.error(`[${ts()}] admin restart failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
