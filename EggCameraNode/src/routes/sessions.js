const express = require('express');
const path    = require('node:path');

const { CAPTURE_TIMEOUT_MS, COMPOSITED_DIR, R2_RETENTION_MS, JOB_HARD_TTL_MS, FRAMES_DIR, FLAME_PATH, ts } = require('../config');
const { ensurePreviewJpeg } = require('../capture');
const { guardRaw } = require('../rawQuality');
const { waitUntilWarm } = require('../warmup');
const camera = require('../adapters/camera');
const { saveComposite, uploadToR2, deferredUploadToR2, generateQRDataUrl } = require('../composite');
const { createSession, getSession, touch, registerPhoto, getPhoto, markCaptureStart } = require('../sessions');
const { composeInChild } = require('../compose');
const jobsStore = require('../jobs');
const worker    = require('../uploadWorker');
const settings  = require('../settings');
const frames    = require('../frames');
const growthFrames = require('../growthFrames');
const fs        = require('node:fs');
const chaos = require('../chaos');

const router = express.Router();

// ── 完成画像ファイル名（=DL ID）: familia_EggCamera_YYYY.MM.DD.HH.mm.ss[.jpg] ──
// 同一秒の衝突だけ _2,_3… を付ける（既存ジョブの fileName と突き合わせ）。
const PHOTO_PREFIX = 'familia_EggCamera';
function makeFileName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const base = `${PHOTO_PREFIX}_${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.`
        + `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    const existing = new Set(jobsStore.listJobs().map(j => j.fileName));
    let name = `${base}.jpg`;
    for (let i = 2; existing.has(name); i++) name = `${base}_${i}.jpg`;
    return name;
}

// 撮影日時: raw ファイル名 YYYYMMDD_HHMMSS から推定（無理なら mtime）。
function capturedAtOf(rawPath) {
    const m = path.basename(rawPath).match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (m) {
        const [, Y, Mo, D, H, Mi, S] = m;
        const t = new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime();
        if (!Number.isNaN(t)) return t;
    }
    try { return fs.statSync(rawPath).mtimeMs; } catch { return Date.now(); }
}

// 登録フレームから1つ抽選（サーバ抽選）。0件ならサンプルにフォールバック。
// 成長するファミちゃん（年齢連動9種＋低確率レア2種）が有効なら月齢で選ぶ。
// 月齢（暦ベース）はクライアントが生年月日から算出して渡す＝同じ区分でも対象期間の
// 実日数はお誕生日によって変わる（クライアント指定。2026-07-29）。
// 有効化は明示オプトイン（GROWTH_FRAMES=1）のみ。無効時は従来どおり一覧からランダム選択。
function pickFrame(months) {
    if (growthFrames.isEnabled()) {
        const g = growthFrames.selectFrame(months);
        if (g) {
            const frameId = g.kind === 'rare' ? `rare_${g.key}` : `growth_lv${g.level}`;
            return { frameId, frameFile: g.file, framePath: g.framePath };
        }
    }
    const all = frames.listFrames();
    if (all.length) {
        const f = all[Math.floor(Math.random() * all.length)];
        return { frameId: f.id, frameFile: f.file, framePath: path.join(FRAMES_DIR, f.file) };
    }
    return { frameId: null, frameFile: null, framePath: FLAME_PATH };
}

// ── POST /api/sessions ─────────────────────────────────────────────────
router.post('/', (req, res) => {
    const session = createSession();
    res.json({ sessionId: session.id });
});

// ── GET /api/sessions/:id ───────────────────────────────────────────────
router.get('/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    touch(session);
    res.json(session);
});

// ── POST /api/sessions/:id/capture ──────────────────────────────────────
router.post('/:id/capture', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    // 確定枚数＋撮影中(in-flight)で頭打ち判定。length だけだと await camera.capture() をまたぐ間に
    // 複数リクエストが >=3 チェックを同時通過し、連打時に4枚目のシャッターが漏れる。
    // Nodeは単一スレッドなので「判定→inFlight++」はawait前に同期実行され、ここで枠を予約してレースを塞ぐ。
    if (session.photos.length + session.inFlight >= 3) {
        return res.status(400).json({ error: 'max_shots_reached' });
    }
    session.inFlight += 1;
    markCaptureStart(); // warmup(捨て撮り)が実撮影との並走を事後検知するための起点

    touch(session);
    session.status = 'capturing';

    try {
        if (chaos.consume('capture')) throw new Error('mac-unreachable');
        // アイドル復帰warmup(捨て撮り)の実行中なら完了を待ってから撮る。同時発火だと
        // iPhone側が in-flight 拒否して実客の1枚目が失敗するため。warmup側はこの撮影要求
        // (inFlight++/markCaptureStart済)を見て以降の捨て撮りを中止するので、実際に待つのは
        // 進行中の捨て撮り高々1回分＝上限は捨て撮り自体のタイムアウトに合わせる。
        await waitUntilWarm(CAPTURE_TIMEOUT_MS + 5_000);
        const { rawPath: capturedPath } = await camera.capture(CAPTURE_TIMEOUT_MS);
        // 12MP混入ガード: 明所での低解像rawは1回だけ自動リテイクして回収する（rawQuality.js）
        const rawPath = await guardRaw(capturedPath, {
            label: 'capture',
            retake: async () => {
                const { rawPath: retaken } = await camera.capture(CAPTURE_TIMEOUT_MS);
                return retaken;
            },
        });
        const previewPath = await ensurePreviewJpeg(rawPath);
        const photoId      = registerPhoto(rawPath, previewPath);
        const photo        = { photoId, url: `/api/photos/${photoId}` };

        session.photos.push(photo);
        session.status = session.photos.length >= 3 ? 'ready' : 'idle';
        res.json(photo);
    } catch (err) {
        session.status = 'idle';
        if (err.message === 'mac-unreachable') {
            return res.status(502).json({ error: 'mac_unreachable' });
        }
        if (err.message === 'capture-timeout') {
            return res.status(504).json({ error: 'capture_timeout' });
        }
        console.error(`[${ts()}] capture failed: ${err.message}`);
        return res.status(500).json({ error: 'capture_failed' });
    } finally {
        session.inFlight -= 1; // 成否に関わらず予約を解放
    }
});

// ── POST /api/sessions/:id/select ───────────────────────────────────────
// Records the user's choices; the actual final image is composited client-side
// and uploaded separately via POST /:id/composite.
router.post('/:id/select', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const { photoId, nickname, days } = req.body || {};
    const photo = session.photos.find(p => p.photoId === photoId);
    if (!photo) return res.status(400).json({ error: 'invalid_photo' });

    touch(session);
    session.selectedPhotoId = photoId;
    session.nickname = nickname;
    session.days     = days;

    res.json({ status: 'ok' });
});

// ── POST /api/sessions/:id/compose ──────────────────────────────────────
// サーバ側で最終画像を原寸合成し、永続ジョブ(composed_pending)として保存。
// プレビュー用のサムネ(dataURL)を返す。決定タップは別途 /confirm で行う。
// body: { photoId, nickname, daysText, days }
router.post('/:id/compose', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const { photoId, nickname = '', daysText = '', days = 0, months = null } = req.body || {};
    const inSession = session.photos.find(p => p.photoId === photoId);
    const photo = inSession && getPhoto(photoId);
    if (!photo) return res.status(400).json({ error: 'invalid_photo' });

    touch(session);
    session.selectedPhotoId = photoId;
    session.nickname = nickname;
    session.days     = days;

    try {
        if (chaos.consume('compose')) throw new Error('injected_compose_failure');
        const crop = settings.getSettings().crop;
        // ズームは撮影時にカメラ(センサークロップ)で適用済みのため、合成段のデジタルズームは1とし
        // 二重ズームを防ぐ。pan(offset)は中央固定のセンサークロップでは表現できないので合成段に残す。
        const composeCrop = { zoom: 1, trim: crop.trim, offsetX: crop.offsetX, offsetY: crop.offsetY };
        const { frameId, frameFile, framePath } = pickFrame(months);

        const fileName = makeFileName();
        // 先にメタだけ作成(compositeBufferなし=composing)。合成は子プロセスで実行し composite.jpg を
        // 直接書く(libvipsのネイティブメモリを親に残さない)。完了後に composed_pending へ更新する。
        const job = jobsStore.createJob({
            sessionId: session.id, fileName, capturedAt: capturedAtOf(photo.rawPath),
            frameId, frameFile, crop: composeCrop, cameraZoom: crop.zoom, nickname, days, daysText,
            sourcePath: photo.rawPath,
        });
        session.composeJobId = job.jobId;

        const { thumbDataUrl } = await composeInChild({
            sourcePath: photo.rawPath, framePath, crop: composeCrop, nickname, daysText,
            outPath: jobsStore.compositePath(job.jobId), thumbMaxSide: 1080,
            dlPreviewPath: jobsStore.dlPreviewPath(job.jobId),
        });
        jobsStore.updateJob(job.jobId, { status: 'composed_pending' });
        res.json({ jobId: job.jobId, fileName, capturedAt: job.capturedAt, thumbDataUrl });
    } catch (err) {
        console.error(`[${ts()}] compose failed (session ${session.id}): ${err.message}`);
        res.status(500).json({ error: 'compose_failed' });
    }
});

// ── POST /api/sessions/:id/confirm ──────────────────────────────────────
// 決定タップ。直前の compose ジョブを確定→アップロード worker へ投入。
// QR はアップロード非依存に即発行して返す（アップロード中でもDL用QRを提示できる）。
router.post('/:id/confirm', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });

    const jobId = (req.body && req.body.jobId) || session.composeJobId;
    const job = jobId && jobsStore.readJob(jobId);
    if (!job) return res.status(400).json({ error: 'no_composed_job' });

    touch(session);
    try {
        if (chaos.consume('qr')) throw new Error('injected_qr_failure');
        const { dataUrl, targetUrl } = await generateQRDataUrl(job.fileName);
        const result = {
            downloadUrl: targetUrl,
            qrDataUrl:   dataUrl,
            expiresAt:   Date.now() + R2_RETENTION_MS, // 確定時は概算。完了時に uploadedAt+24H へ更新
        };
        const confirmedAt = Date.now();
        // 失敗ジョブの強制削除期限を確定時に算出（confirmedAt+48h）。
        // worker は confirmedAt+24h で自動リトライを止め、confirmedAt+48h(=deleteAfter)で削除する。
        jobsStore.updateJob(jobId, {
            status: 'queued', confirmedAt,
            deleteAfter: confirmedAt + JOB_HARD_TTL_MS, result,
        });
        worker.enqueue(jobId);

        // 既存の status ポーリング(GET /sessions/:id)で QR を拾えるよう session にも反映
        session.result = result;
        session.status = 'done';

        // jobId/fileName もフロントへ返す。セッション終了時のアップロード完了判定(系統B)に使う。
        res.status(202).json({ status: 'uploading', jobId, fileName: job.fileName, ...result });
    } catch (err) {
        console.error(`[${ts()}] confirm failed (session ${session.id}): ${err.message}`);
        res.status(500).json({ error: 'confirm_failed' });
    }
});

// ── POST /api/sessions/:id/composite ────────────────────────────────────
// Receives the final composited image (photo + frame + name/days, baked in
// the browser via canvas) as a raw PNG body, uploads it to R2, and generates
// the download QR.
router.post('/:id/composite', express.raw({ type: ['image/jpeg', 'image/png'], limit: '40mb' }), async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'invalid_image' });
    }

    touch(session);
    session.status = 'compositing';
    session.error  = undefined;
    session.result = undefined;

    res.status(202).json({ status: 'compositing' });

    (async () => {
        // ローカル保存は必須（失敗＝復旧不能なので従来どおりエラー）
        let fileName;
        try {
            ({ fileName } = await saveComposite(req.body));
        } catch (err) {
            console.error(`[${ts()}] composite save failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
            return;
        }
        const localPath = path.join(COMPOSITED_DIR, fileName);

        // 通常経路: R2へ即アップロード。成功すればそのままDL可能。
        let uploaded = false;
        try {
            if (chaos.consume('r2')) throw new Error('injected_r2_failure');
            await uploadToR2(localPath, fileName);
            uploaded = true;
        } catch (err) {
            // ★ 代替経路（不安定時のみ）: アップロードは諦めず後追いリトライに回す。
            console.warn(`[${ts()}] R2 upload failed (${err.message}); switching to deferred upload`);
        }

        // QRは想定URLで作れる（アップロード成否に依存しない）。
        // QR生成自体の失敗は通信と無関係なので、これは従来どおりエラー扱い。
        let dataUrl, targetUrl;
        try {
            if (chaos.consume('qr')) throw new Error('injected_qr_failure');
            ({ dataUrl, targetUrl } = await generateQRDataUrl(fileName));
        } catch (err) {
            console.error(`[${ts()}] QR generation failed: ${err.message}`);
            session.status = 'error';
            session.error  = 'composite_failed';
            return;
        }

        session.result = {
            downloadUrl: targetUrl,
            qrDataUrl:   dataUrl,
            expiresAt:   Date.now() + R2_RETENTION_MS,
            deferred:    !uploaded, // アップロードが後追いなら true（DLに時間差が出る）
        };
        session.status = 'done';

        // 後追いアップロードをバックグラウンドで開始。ユーザーは時間をおいてDLできる。
        if (!uploaded) {
            console.warn(`[${ts()}] deferred-upload mode → ${fileName} (QR shown immediately)`);
            deferredUploadToR2(localPath, fileName).catch(() => {});
        }
    })();
});

module.exports = router;
