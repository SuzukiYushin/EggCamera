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
const { listFailedUploads, retryFailedUpload, presignPutUrl, r2ObjectExists } = require('../composite');
const { ensureRasterSource } = require('../compose');
const jobsStore = require('../jobs');
const frames   = require('../frames');
const growthFrames = require('../growthFrames');
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

// ── 成長するファミちゃん（年齢連動9種＋レア2種）一覧 ─────────────────────
// 有効時は年齢連動選択が上のランダム一覧より優先される（routes/sessions.js pickFrame）。
router.get('/growth-frames', (req, res) => {
    res.json(growthFrames.listAll());
});

function growthFrameToJson(f) {
    return { ...f, url: `/frames/${f.file}` };
}

// ── 成長フレーム追加（月齢カテゴリ level を指定。画像バイナリを直接POST） ──
// 日数範囲はサーバ側の固定カテゴリ表から決まる（管理画面はプルダウンで level を選ぶ）。
router.post('/growth-frames/growth',
    express.raw({ type: ['image/png', 'image/jpeg'], limit: '30mb' }),
    (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ error: 'invalid_image' });
        }
        const ext = req.get('Content-Type') === 'image/jpeg' ? '.jpg' : '.png';
        try {
            res.json(growthFrameToJson(growthFrames.addGrowthFrame({ level: req.query.level }, req.body, ext)));
        } catch (err) {
            console.error(`[${ts()}] growth frame add failed: ${err.message}`);
            res.status(400).json({ error: err.message });
        }
    });

// ── レアアイテム追加（key/label を指定。画像バイナリを直接POST） ──────────
router.post('/growth-frames/rare',
    express.raw({ type: ['image/png', 'image/jpeg'], limit: '30mb' }),
    (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ error: 'invalid_image' });
        }
        const ext = req.get('Content-Type') === 'image/jpeg' ? '.jpg' : '.png';
        const key = decodeURIComponent(req.get('X-Rare-Key') || '');
        const label = decodeURIComponent(req.get('X-Rare-Label') || '');
        try {
            res.json(growthFrameToJson(growthFrames.addRareFrame({ key, label }, req.body, ext)));
        } catch (err) {
            console.error(`[${ts()}] rare frame add failed: ${err.message}`);
            res.status(400).json({ error: err.message });
        }
    });

// ── Mac mini ローカルのファイルを読む共通処理（ホーム以下に制限） ──────────
// 成長フレーム/レアの「Mac miniのデータから選ぶ」経路で使う。旧フレームの
// /frames/from-server と同じガード（ホーム外・非ファイル・拡張子）を掛ける。
function readServerImage(srcPath) {
    const resolved = path.resolve(srcPath || '');
    if (!resolved.startsWith(HOME)) throw new Error('path_outside_home');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('file_not_found');
    const ext = path.extname(resolved).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('invalid_ext');
    return { buffer: fs.readFileSync(resolved), ext: ext === '.jpeg' ? '.jpg' : ext };
}

// ── 成長フレーム追加（Mac mini ローカルのファイルパスから） ────────────────
router.post('/growth-frames/growth/from-server', (req, res) => {
    const { path: srcPath, level } = req.body || {};
    try {
        const { buffer, ext } = readServerImage(srcPath);
        res.json(growthFrameToJson(growthFrames.addGrowthFrame({ level }, buffer, ext)));
    } catch (err) {
        console.error(`[${ts()}] growth frame add (server) failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// ── レアアイテム追加（Mac mini ローカルのファイルパスから） ────────────────
router.post('/growth-frames/rare/from-server', (req, res) => {
    const { path: srcPath, key, label } = req.body || {};
    try {
        const { buffer, ext } = readServerImage(srcPath);
        res.json(growthFrameToJson(growthFrames.addRareFrame({ key, label }, buffer, ext)));
    } catch (err) {
        console.error(`[${ts()}] rare frame add (server) failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// ── 成長フレーム削除（一覧から外すだけ。実ファイルは .trash に残る） ───────
router.delete('/growth-frames/growth/:level', (req, res) => {
    try {
        res.json(growthFrameToJson(growthFrames.deleteGrowthFrame(req.params.level)));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ── レアアイテム全体の出現率を更新（prob は 0..1。1枚あたりは自動で均等割り） ──
router.patch('/growth-frames/rare-probability', (req, res) => {
    try {
        res.json(growthFrames.setRareProbability((req.body || {}).prob));
    } catch (err) {
        console.error(`[${ts()}] rare probability update failed: ${err.message}`);
        res.status(400).json({ error: err.message });
    }
});

// ── レアアイテム削除 ─────────────────────────────────────────────────────
router.delete('/growth-frames/rare/:key', (req, res) => {
    try {
        res.json(growthFrameToJson(growthFrames.deleteRareFrame(req.params.key)));
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
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
router.get('/settings', (req, res) => res.json({
    ...settings.getSettings(),
    // ズームゲージの無劣化範囲表示用メタ。無劣化上限 = captureLongEdge / outputLongEdge。
    meta: {
        captureLongEdge: 8064,  // iPhone17メイン 48MP の長辺(2:3クロップ後も不変)
        outputLongEdge: parseInt(process.env.COMPOSE_MAX_HEIGHT || '3600', 10), // 完成画像の長辺
    },
}));
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
        manualLock:        j.manualLock || false,
        manualMode:        j.manualMode || null,
        attentionRequired: j.attentionRequired || false,
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

// ── ブラウザ再合成に必要なパラメータ一式（crop/名前/日数/source URL） ──────────
// フレームは別途 GET /api/admin/frames（一覧）＋ /frames/<file>（本体）から取得する。
router.get('/jobs/:id/params', (req, res) => {
    const id  = path.basename(req.params.id);
    const job = jobsStore.readJob(id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json({
        jobId:     job.jobId,
        fileName:  job.fileName,
        status:    job.status,
        crop:      job.crop || { zoom: 1, offsetX: 0, offsetY: 0 },
        nickname:  job.nickname || '',
        daysText:  job.daysText || '',
        days:      job.days || 0,
        sourceUrl: `/api/admin/jobs/${job.jobId}/source.jpg`,
    });
});

// ── ブラウザ合成用に source を JPEG 化して提供（HEIC はブラウザ canvas で扱えない） ──
router.get('/jobs/:id/source.jpg', async (req, res) => {
    const id  = path.basename(req.params.id);
    const job = jobsStore.readJob(id);
    const src = job && jobsStore.sourcePathOf(job);
    if (!src) return res.status(404).json({ error: 'source_not_found' });
    try {
        const { rasterPath, cleanup } = await ensureRasterSource(src);
        res.sendFile(rasterPath, (err) => {
            if (cleanup) fs.rm(rasterPath, { force: true }, () => {});
            if (err && !res.headersSent) res.status(500).end();
        });
    } catch (err) {
        console.error(`[${ts()}] source.jpg failed (${id}): ${err.message}`);
        res.status(500).json({ error: 'source_convert_failed' });
    }
});

// ── 直R2アップロード用の署名付きPUT URLを発行（手動救済の開始） ─────────────────
// mode='reupload'(再送) は切替前に取得して保持し切替後にPUT、'recompose'(再合成) は
// 合成後すぐPUT。発行と同時に manualLock を立て worker の自動リトライを止める（排他）。
router.post('/jobs/:id/presign', async (req, res) => {
    const id  = path.basename(req.params.id);
    const job = jobsStore.readJob(id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (job.status === 'done') return res.status(409).json({ error: 'already_done' });
    const mode = (req.body && req.body.mode === 'recompose') ? 'recompose' : 'reupload';
    try {
        const presign = await presignPutUrl(job.fileName, { expiresIn: 900 });
        // ロックに期限を付ける（署名15分＋PUT完了余裕10分）。スタッフが発行後に操作を
        // 放棄すると worker の自動リトライが恒久停止する穴を塞ぐ（期限切れは
        // checkManualUploads が解除して自動リトライへ戻す）。
        jobsStore.updateJob(id, {
            manualLock: true, manualMode: mode,
            manualLockUntil: Date.now() + 25 * 60_000,
        });
        console.log(`[${ts()}] job ${id}: manual ${mode} started (presigned PUT issued)`);
        res.json({
            uploadUrl: presign.url, key: job.fileName,
            expiresIn: presign.expiresIn, expiresAt: presign.expiresAt,
        });
    } catch (err) {
        console.error(`[${ts()}] presign failed (${id}): ${err.message}`);
        res.status(500).json({ error: 'presign_failed' });
    }
});

// ── 手動アップロード完了の即時通知（従経路）。R2 HEAD で実在確認して done 化 ──────
// ネット復帰後にブラウザが叩く。未検出は 409（ブラウザは数秒後にリトライ、
// または worker の HEAD ループが最終的に done 化する）。
router.post('/jobs/:id/complete', async (req, res) => {
    const id  = path.basename(req.params.id);
    const job = jobsStore.readJob(id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (job.status === 'done') {
        return res.json({ ok: true, status: 'done',
            qrDataUrl: job.result?.qrDataUrl || null, downloadUrl: job.result?.downloadUrl || null });
    }
    let exists = false;
    try { exists = await r2ObjectExists(job.fileName); } catch { exists = false; }
    if (!exists) return res.status(409).json({ error: 'not_uploaded_yet' });
    const done = jobsStore.markManualDone(id);
    console.log(`[${ts()}] job ${id}: manual ${job.manualMode || ''} confirmed (complete API) → done`);
    res.json({ ok: true, status: 'done',
        qrDataUrl: done?.result?.qrDataUrl || null, downloadUrl: done?.result?.downloadUrl || null });
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
