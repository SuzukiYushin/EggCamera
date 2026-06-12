const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const QRCode = require('qrcode');

const {
    COMPOSITED_DIR, FRAMES_DIR, FLAME_PATH, MAX_COMPOSITED,
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL,
    PAGES_BASE_URL, R2_RETENTION_MS, ts,
} = require('./config');
const { heicToJpeg } = require('./capture');

fs.mkdirSync(COMPOSITED_DIR, { recursive: true });

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId:     R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
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

        const totalMB = (objects.reduce((s, o) => s + (o.Size || 0), 0) / 1024 / 1024).toFixed(1);
        console.log(`[${ts()}] R2 cleanup: ${objects.length} objects (${totalMB}MB), ${toDelete.length} to delete`);

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
    cleanupOldR2Objects,
    listAllR2Objects,
    trimLocalDir,
};
