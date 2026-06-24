const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const express = require('express');

// 管理(運用)ルーター。admin別プロセス(:3001)で動く。撮影coreに密結合する
// metrics/test-capture/chaos/selftest は adminCore.js(:3000) 側にあり、ここには無い
// （admin-server.js が core へプロキシする）。
const http = require('node:http');
const { DATA_DIR, FAILED_DIR, REBOOT_PASSWORD, PORT, ts } = require('../config');
const adminAuth = require('./adminAuth');
const { diagnose } = require('../diagnose');
const ops = require('../ops');
const { listFailedUploads, retryFailedUpload } = require('../composite');
const jobsStore = require('../jobs');
const frames   = require('../frames');
const settings = require('../settings');
const logger   = require('../logger');
const slack    = require('../slack');
const mode     = require('../mode');

const router = express.Router();
router.use(express.json());
router.use(adminAuth);

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

// metrics / test-capture は adminCore.js(core:3000) 側。admin-server がプロキシする。

// ── クロップ設定 ─────────────────────────────────────────────────────────
router.get('/settings', (req, res) => res.json(settings.getSettings()));
router.put('/settings', (req, res) => {
    const saved = settings.saveSettings(req.body);
    // 設定変更を iPad Safari へリアルタイムプッシュ（SSE経由で core に通知）
    const req2 = http.request({ host: '127.0.0.1', port: PORT, path: '/api/internal/reload-signal', method: 'POST' });
    req2.on('error', () => {});
    req2.end();
    res.json(saved);
});

// ── ログ（リングバッファ） ────────────────────────────────────────────────
router.get('/logs', (req, res) => {
    const since = parseInt(req.query.since || '0', 10) || 0;
    res.json(logger.getLogs(since));
});

// chaos は adminCore.js(core:3000) 側（撮影パスが consume するため）。admin-server がプロキシ。

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

// ── サーバ合成ジョブ（処理中/失敗で要確認のもの） ─────────────────────────
// 撮影日時・現在ステータス・DL用QR・手動DLリンクを返す。フロントは数秒間隔で
// ポーリングしてリアルタイム表示する（合成失敗/アップロード中/完了 の遷移が見える）。
router.get('/jobs', (req, res) => {
    res.json(jobsStore.listAdminJobs().map(j => ({
        jobId:       j.jobId,
        fileName:    j.fileName,
        capturedAt:  j.capturedAt,
        status:      j.status,
        lastError:   j.lastError,
        confirmedAt: j.confirmedAt,
        uploadedAt:  j.uploadedAt,
        qrDataUrl:   j.result && j.result.qrDataUrl   || null,
        downloadUrl: j.result && j.result.downloadUrl || null,
        imageUrl:    `/api/admin/jobs/${j.jobId}/image`,
    })));
});

// 合成画像本体（管理画面のサムネ表示＆手動ダウンロード）。
router.get('/jobs/:id/image', (req, res) => {
    const id  = path.basename(req.params.id); // パストラバーサル防止
    const job = jobsStore.readJob(id);
    const p   = jobsStore.compositePath(id);
    if (!job || !fs.existsSync(p)) return res.status(404).json({ error: 'not_found' });
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${job.fileName}"`);
    res.sendFile(p);
});

// ── Slack 通知（監視ループ/エージェントからのバグ修正・人力対応報告用） ───
// POST {text, kind?: 'fix'|'warn'|'alert'|'info', action?: 'none'|'fix'|'restart'|'investigate'}
//   kind=重要度アイコン, action=先頭のアクション種別タグ(何をすべきか)
router.post('/notify', (req, res) => {
    const { text, kind, action } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text_required' });
    const level = ['fix', 'warn', 'alert', 'info'].includes(kind) ? kind : 'info';
    const act = ['none', 'fix', 'restart', 'investigate'].includes(action) ? action : null;
    const sent = slack.notify(text.slice(0, 1500), { level, action: act });
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

// selftest は adminCore.js(core:3000) 側（撮影パイプライン）。admin-server がプロキシ。

// ── 再起動タブ: 診断＋パスワード保護の再起動 ─────────────────────────────
// どの対象を再起動すべきかをログから推定
router.get('/diagnose', (req, res) => res.json(diagnose()));

// 再起動実行（パスワード必須）。target = iphone|mac|node|iphone-reboot|iphone-refresh|mac-reboot
router.post('/restart/:target', async (req, res) => {
    // fail-closed: パスワード未設定(.envにREBOOT_PASSWORDが無い)なら一切受け付けない。
    // 空文字一致による素通りを防ぐ（既定値はコードに持たない方針）。
    if (!REBOOT_PASSWORD) {
        return res.status(503).json({ error: 'reboot_password_not_configured' });
    }
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
