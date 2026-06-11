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
function trimLocalDir(dir, max) {
    let files;
    try {
        files = fs.readdirSync(dir).filter(f => /\.(png|jpg)$/i.test(f)).sort();
    } catch { return; }
    if (files.length <= max) return;
    for (const f of files.slice(0, files.length - max)) {
        try { fs.rmSync(path.join(dir, f)); } catch { /* ignore */ }
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
    generateQRDataUrl,
    uploadToR2,
    cleanupOldR2Objects,
    listAllR2Objects,
    trimLocalDir,
};
