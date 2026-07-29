const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
// sharp(libvips) はデフォルトで最大50MBのネイティブキャッシュ＋CPUコア数ぶんの
// ワーカースレッド(=アロケータarena断片化)を持ち、長期運用でRSSが単調増加する
// （heapは安定なのにRSSだけ増える＝ネイティブ側リーク。実測 97→175→261MB）。
// キャッシュ無効化＋並列度1でRSS滞留を抑える。本サーバは1枚ずつの逐次処理なので
// concurrency=1でも実用上スループットに影響しない。
sharp.cache(false);
sharp.concurrency(1);
const { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const QRCode = require('qrcode');

const {
    COMPOSITED_DIR, PREVIEW_DIR, DEFERRED_DIR, FAILED_DIR, FRAMES_DIR, FLAME_PATH, MAX_COMPOSITED,
    DEFERRED_MAX_MS,
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
    PAGES_BASE_URL, R2_RETENTION_MS, ts,
} = require('./config');
const { heicToJpeg } = require('./capture');
const slack = require('./slack');

// R2無料枠(10GB)に近づいたら警告する閾値
const R2_WARN_BYTES = 8 * 1024 * 1024 * 1024; // 8GB

fs.mkdirSync(COMPOSITED_DIR, { recursive: true });
fs.mkdirSync(DEFERRED_DIR, { recursive: true });
fs.mkdirSync(FAILED_DIR, { recursive: true });

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId:     R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    maxAttempts: 3,
    // ハングしたTCPで個々の send が無限ブロックしないよう上限を持たせる
    // （cleanup/selftest 等の即時経路がタイムアウト無しで詰まるのを防ぐ）。
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 30_000 }),
});

// ── Resolve a frame asset, falling back to the sample flame frame ─────────
function resolveFramePath(frameId) {
    if (frameId) {
        const candidate = path.join(FRAMES_DIR, `${frameId}.png`);
        if (fs.existsSync(candidate)) return candidate;
        console.warn(`[${ts()}] frame "${frameId}" not found, falling back to flame_sample.png`);
    }
    return FLAME_PATH;
}

// ── Composite the selected raw photo with the chosen frame ────────────────
async function compositeForSession(rawPath, frameId, sessionId) {
    const ext      = path.extname(rawPath).toLowerCase();
    const fileName = `${sessionId}.jpg`;
    const destPath = path.join(COMPOSITED_DIR, fileName);
    const tmpPath  = path.join(os.tmpdir(), `eggcamera_${sessionId}.jpg`);

    let sourcePath = rawPath;
    let cleanupTmp = false;
    if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
        await heicToJpeg(rawPath, tmpPath);
        sourcePath = tmpPath;
        cleanupTmp = true;
    }

    try {
        const base  = sharp(sourcePath);
        const meta  = await base.metadata();
        const flame = await sharp(resolveFramePath(frameId))
            .resize(meta.width, meta.height, { fit: 'fill' })
            .toBuffer();

        await base
            .composite([{ input: flame, blend: 'over' }])
            .jpeg({ quality: 95 })
            .toFile(destPath);

        console.log(`[${ts()}] composite saved → ${fileName}`);
        trimLocalDir(COMPOSITED_DIR, MAX_COMPOSITED);
        // HEIC→JPEG変換のプレビューはraw本体と違い掃除されず無限に溜まるため、ここで一緒にトリムする
        trimLocalDir(PREVIEW_DIR, MAX_COMPOSITED);

        return { fileName, destPath };
    } finally {
        if (cleanupTmp) fs.rm(tmpPath, { force: true }, () => {});
    }
}

// ローカル時刻で YYYY.MM.DD.HH.mm.ss のベース名を作る
function timestampBaseName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}.`
        + `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// ダウンロード写真のファイル名プレフィックス
const PHOTO_PREFIX = 'familia_EggCamera';

// ── Save a client-composited PNG (photo + frame + text, baked in the browser) ──
// ファイル名（=QRのダウンロードID）は familia_EggCamera_YYYY.MM.DD.HH.mm.ss。
// 同じ秒に複数枚保存された場合のみ _2, _3… を付けて衝突を避ける。
async function saveComposite(buffer) {
    const base = `${PHOTO_PREFIX}_${timestampBaseName()}`;
    let fileName = `${base}.jpg`;
    for (let i = 2; fs.existsSync(path.join(COMPOSITED_DIR, fileName)); i++) {
        fileName = `${base}_${i}.jpg`;
    }
    const destPath = path.join(COMPOSITED_DIR, fileName);

    await sharp(buffer).jpeg({ quality: 95 }).toFile(destPath);

    console.log(`[${ts()}] composite saved → ${fileName}`);
    trimLocalDir(COMPOSITED_DIR, MAX_COMPOSITED);
    // HEIC→JPEG変換のプレビューはraw本体と違い掃除されず無限に溜まるため、ここで一緒にトリムする
    trimLocalDir(PREVIEW_DIR, MAX_COMPOSITED);

    return { fileName, destPath };
}

// ── QR code as a data URL pointing at the download page / R2 object ──────
async function generateQRDataUrl(fileName) {
    // download/index.html appends ".jpg" to `id` itself, so strip it here
    // to avoid a double extension when fetching from /image/[id].js.
    const id = fileName.replace(/\.jpg$/i, '');
    const targetUrl = PAGES_BASE_URL
        ? `${PAGES_BASE_URL}/download?id=${id}`
        : `${R2_PUBLIC_BASE_URL}/${fileName}`;

    const dataUrl = await QRCode.toDataURL(targetUrl, {
        width:  400,
        margin: 2,
        color:  { dark: '#3a3a3a', light: '#ffffff' },
    });

    console.log(`[${ts()}] QR generated for ${fileName} → ${targetUrl}`);
    return { dataUrl, targetUrl };
}

// ── Trim a local directory to the N most recent files ─────────────────────
// 更新時刻の新しい順に並べて古いものから削除する。ファイル名はランダムhexなので
// 名前順で消すと「今保存したばかりのファイル」を消してしまい、直後のR2アップロードが
// ENOENT で落ちる（長期運用で件数が max を超えた瞬間に発生していた）。
function trimLocalDir(dir, max) {
    let files;
    try {
        files = fs.readdirSync(dir)
            .filter(f => /\.(png|jpg)$/i.test(f))
            .map(f => {
                const full = path.join(dir, f);
                let mtime = 0;
                try { mtime = fs.statSync(full).mtimeMs; } catch { /* 競合で消えていれば0 */ }
                return { full, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime); // 新しい順
    } catch { return; }
    if (files.length <= max) return;
    for (const { full } of files.slice(max)) {
        try { fs.rmSync(full); } catch { /* ignore */ }
    }
}

// ── R2 upload (PutObject only, cleanup is separate) ────────────────────────
async function uploadToR2(filePath, key) {
    const body = fs.readFileSync(filePath);
    await r2.send(new PutObjectCommand({
        Bucket:      R2_BUCKET,
        Key:         key,
        Body:        body,
        ContentType: 'image/jpeg',
    }));
    console.log(`[${ts()}] R2 uploaded → ${key}`);
}

// ── 管理画面ブラウザからの「直R2アップロード」用 署名付きPUT URL ─────────────
// 管理PCのネット回線で直接R2へPUTさせるため。Key/ContentType はサーバが固定して
// 署名する（クライアントが任意キーへ書き込めない・改ざんで SignatureDoesNotMatch）。
// 短命（既定15分）。ネット切替前に発行→保持し、切替後にPUTする運用。
async function presignPutUrl(key, { expiresIn = 900 } = {}) {
    const cmd = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: 'image/jpeg' });
    const url = await getSignedUrl(r2, cmd, { expiresIn });
    return { url, expiresIn, expiresAt: Date.now() + expiresIn * 1000 };
}

// R2 にオブジェクトが実在するか（手動アップロード後の done 確定確認に使う）。
// ブラウザがサーバ不達でも、worker の HEAD 確認で done に到達できる。
async function r2ObjectExists(key) {
    try {
        await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return true;
    } catch {
        return false;
    }
}

// 任意ファイルをR2へ（バックアップ用・ContentType指定可）
async function uploadFileToR2(filePath, key, contentType = 'application/octet-stream') {
    await r2.send(new PutObjectCommand({
        Bucket:      R2_BUCKET,
        Key:         key,
        Body:        fs.readFileSync(filePath),
        ContentType: contentType,
    }));
    console.log(`[${ts()}] R2 uploaded (backup) → ${key}`);
}

// ── 不安定ネットワーク時の後追いアップロード ──────────────────────────────
// 通常経路の即時アップロードが失敗したときだけ使う代替手段。
// QRは想定URLで先に出してあるので、ここでバックグラウンドで粘って成功させれば
// ユーザーは時間をおいてからダウンロードできる。
// ・対象ファイルは DEFERRED_DIR に退避してトリム(30件)で消えないよう保護する
// ・即時1回→バックオフで R2_RETENTION_MS(24時間) までリトライし続ける
// ・DEFERRED_MAX_MS(1時間)を超えたら、アップは継続したまま FAILED_DIR にも複製して
//   管理画面の「失敗画像」一覧に出す（手動DL/再試行が可能）。
//   後からアップに成功すれば一覧からも自動で消える。
const DEFERRED_DELAYS_MS = [0, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000];

async function deferredUploadToR2(sourcePath, key, { maxMs = R2_RETENTION_MS, listAfterMs = DEFERRED_MAX_MS } = {}) {
    const safePath   = path.join(DEFERRED_DIR, key);
    const failedPath = path.join(FAILED_DIR, key);
    try {
        if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, safePath);
    } catch (err) {
        console.error(`[${ts()}] deferred copy failed → ${key}: ${err.message}`);
    }

    const startedAt = Date.now();
    let attempt = 0;
    let listed = false;
    while (Date.now() - startedAt < maxMs) {
        const waitMs = DEFERRED_DELAYS_MS[Math.min(attempt, DEFERRED_DELAYS_MS.length - 1)];
        if (waitMs) await new Promise(r => setTimeout(r, waitMs));
        attempt += 1;

        const working = fs.existsSync(safePath) ? safePath
            : (fs.existsSync(failedPath) ? failedPath : null);
        if (!working) {
            console.error(`[${ts()}] deferred upload aborted (file gone) → ${key}`);
            return false;
        }
        try {
            await uploadToR2(working, key);
            console.log(`[${ts()}] deferred upload succeeded on attempt ${attempt} → ${key}`);
            try { fs.rmSync(safePath,   { force: true }); } catch { /* ignore */ }
            try { fs.rmSync(failedPath, { force: true }); } catch { /* ignore */ } // 管理画面の失敗一覧からも除く
            return true;
        } catch (err) {
            console.warn(`[${ts()}] deferred upload attempt ${attempt} failed → ${key}: ${err.message}`);
        }

        // 1時間経過したら（アップは継続したまま）管理画面の失敗一覧へ追加
        if (!listed && Date.now() - startedAt >= listAfterMs) {
            try {
                fs.copyFileSync(safePath, failedPath);
                listed = true;
                console.warn(`[${ts()}] deferred upload overdue (>1h), listed in admin → ${key}`);
                // 人力対応が要る合図。連投を避け15分に1回だけ件数つきで通知
                slack.notify(
                    `アップロードに失敗した写真があります（現在 ${listFailedUploads().length} 件）。`
                    + `管理画面の「失敗画像」タブで再送/ダウンロードしてください。`,
                    { level: 'warn', key: 'failed-uploads', throttleMs: 15 * 60_000 });
            } catch { /* ignore */ }
        }
    }

    // 24時間粘っても無理 → 失敗一覧に残したまま作業コピーだけ片付ける
    if (!fs.existsSync(failedPath)) {
        try { fs.copyFileSync(safePath, failedPath); } catch { /* ignore */ }
    }
    fs.rm(safePath, { force: true }, () => {});
    console.error(`[${ts()}] deferred upload gave up after 24h → ${key} (kept in failed list)`);
    slack.notify(
        `写真 ${key} を24時間アップロードできませんでした。管理画面の「失敗画像」から手動で再送してください。`,
        { level: 'alert', key: `gaveup-${key}`, throttleMs: 60 * 60_000 });
    return false;
}

// ── 失敗画像（1時間アップできなかったもの）の一覧と再アップロード ──────────
function listFailedUploads() {
    let files;
    try { files = fs.readdirSync(FAILED_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)); }
    catch { return []; }
    return files.map(f => {
        let failedAt = 0;
        try { failedAt = fs.statSync(path.join(FAILED_DIR, f)).mtimeMs; } catch { /* ignore */ }
        return { fileName: f, failedAt };
    }).sort((a, b) => b.failedAt - a.failedAt);
}

// 管理画面からの手動再アップロード。成功したら FAILED_DIR から除く。
async function retryFailedUpload(fileName) {
    const p = path.join(FAILED_DIR, fileName);
    if (!fs.existsSync(p)) throw new Error('not_found');
    await uploadToR2(p, fileName);
    fs.rm(p, { force: true }, () => {});
    console.log(`[${ts()}] failed upload re-sent OK → ${fileName}`);
}

// ── R2 cleanup: delete objects older than R2_RETENTION_MS ─────────────────
async function cleanupOldR2Objects() {
    try {
        const objects = await listAllR2Objects();
        if (!objects.length) {
            console.log(`[${ts()}] R2 cleanup: bucket empty`);
            return;
        }

        const cutoff   = Date.now() - R2_RETENTION_MS;
        const toDelete = objects
            .filter(o => o.LastModified && o.LastModified.getTime() < cutoff)
            .map(o => ({ Key: o.Key }));

        const totalBytes = objects.reduce((s, o) => s + (o.Size || 0), 0);
        const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
        console.log(`[${ts()}] R2 cleanup: ${objects.length} objects (${totalMB}MB), ${toDelete.length} to delete`);

        // 無料枠(10GB)に近づいたら課金警告（6時間に1回）
        if (totalBytes >= R2_WARN_BYTES) {
            slack.notify(
                `R2ストレージが ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB に達しました（無料枠10GB）。`
                + `保持期間の短縮や不要オブジェクト削除を検討してください。`,
                { level: 'warn', key: 'r2-storage', throttleMs: 6 * 60 * 60_000 });
        }

        if (!toDelete.length) return;

        for (let i = 0; i < toDelete.length; i += 1000) {
            const batch = toDelete.slice(i, i + 1000);
            await r2.send(new DeleteObjectsCommand({
                Bucket: R2_BUCKET,
                Delete: { Objects: batch },
            }));
        }
        console.log(`[${ts()}] R2 cleanup: deleted ${toDelete.length} object(s)`);
    } catch (err) {
        console.error(`[${ts()}] R2 cleanup failed: ${err.message}`);
    }
}

async function listAllR2Objects() {
    const objects = [];
    let continuationToken;
    do {
        const res = await r2.send(new ListObjectsV2Command({
            Bucket:            R2_BUCKET,
            ContinuationToken: continuationToken,
        }));
        if (res.Contents) objects.push(...res.Contents);
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
}

module.exports = {
    resolveFramePath,
    compositeForSession,
    saveComposite,
    generateQRDataUrl,
    uploadToR2,
    uploadFileToR2,
    presignPutUrl,
    r2ObjectExists,
    deferredUploadToR2,
    listFailedUploads,
    retryFailedUpload,
    cleanupOldR2Objects,
    listAllR2Objects,
    trimLocalDir,
};
