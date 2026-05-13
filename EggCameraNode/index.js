require('dotenv').config();

const fs     = require('node:fs');
const http   = require('node:http');
const os     = require('node:os');
const path   = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const sharp  = require('sharp');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const QRCode = require('qrcode');

// ── Paths ──────────────────────────────────────────────
const DATA_DIR       = path.resolve(__dirname, '../data');
const RAW_DIR        = path.join(DATA_DIR, 'raw');
const COMPOSITED_DIR = path.join(DATA_DIR, 'composited');
const QR_DIR         = path.join(DATA_DIR, 'qrcodes');
const FLAME_PATH     = path.join(DATA_DIR, 'assets/frames/flame_sample.png');

// ── Trigger config ─────────────────────────────────────
const SWIFT_HOST  = process.env.SWIFT_HOST  || 'localhost';
const SWIFT_PORT  = parseInt(process.env.SWIFT_PORT  || '8082', 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '5000', 10);

// ── R2 config ──────────────────────────────────────────
const R2_RETENTION_MS      = 3 * 60 * 1000; // 3分（検証用。本番は 3 * 24 * 60 * 60 * 1000）
const R2_CLEANUP_INTERVAL  = 60 * 60 * 1000;           // 1時間ごと

const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;

// ── Ensure output dirs exist ───────────────────────────
const MAX_COMPOSITED = 30;
fs.mkdirSync(COMPOSITED_DIR, { recursive: true });
fs.mkdirSync(QR_DIR,         { recursive: true });

// ── Composite ──────────────────────────────────────────
function heicToJpeg(srcPath, destPath) {
    return new Promise((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath],
            (err) => err ? reject(err) : resolve());
    });
}

async function composite(rawPath) {
    const base     = path.basename(rawPath, path.extname(rawPath));
    const rand     = crypto.randomBytes(4).toString('hex'); // 8文字ランダム16進数
    const fileName = `${base}_${rand}`;                    // 例: 20260513_143022_a3f9k2m7
    const destPath = path.join(COMPOSITED_DIR, `${fileName}.jpg`);
    const tmpPath  = path.join(os.tmpdir(), `eggcamera_${base}.jpg`);

    try {
        await heicToJpeg(rawPath, tmpPath);

        const base  = sharp(tmpPath);
        const meta  = await base.metadata();
        const flame = await sharp(FLAME_PATH)
            .resize(meta.width, meta.height, { fit: 'fill' })
            .toBuffer();

        await base
            .composite([{ input: flame, blend: 'over' }])
            .jpeg({ quality: 95 })
            .toFile(destPath);

        console.log(`[${ts()}] composite saved → ${path.basename(destPath)}`);
        trimLocalComposited();

        await uploadToR2(destPath, `${fileName}.jpg`);
        await generateQR(fileName);
    } catch (err) {
        console.error(`[${ts()}] composite failed for ${path.basename(rawPath)}: ${err.message}`);
    } finally {
        fs.rm(tmpPath, { force: true }, () => {});
    }
}

// ── Trim local composited/ to MAX_COMPOSITED ───────────
function trimLocalComposited() {
    trimLocalDir(COMPOSITED_DIR, MAX_COMPOSITED);
}

// ── QR Code 生成 ───────────────────────────────────────
async function generateQR(fileName) {
    const pagesBase = process.env.PAGES_BASE_URL;
    if (!pagesBase) {
        console.log(`[${ts()}] QR skipped: PAGES_BASE_URL not set`);
        return;
    }

    const url    = `${pagesBase}/download?id=${fileName}`;
    const qrPath = path.join(QR_DIR, `${fileName}.png`);

    await QRCode.toFile(qrPath, url, {
        width:           400,
        margin:          2,
        color: { dark: '#3a3a3a', light: '#ffffff' },
    });
    console.log(`[${ts()}] QR saved → ${path.basename(qrPath)} (${url})`);
    trimLocalDir(QR_DIR, MAX_COMPOSITED);
}

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

// ── R2 upload（PutObjectのみ、クリーンアップは別途）─────
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

// ── R2 cleanup: 3日より古いオブジェクトをまとめて削除 ──
async function cleanupOldR2Objects() {
    try {
        const objects = await listAllR2Objects();
        if (!objects.length) {
            console.log(`[${ts()}] R2 cleanup: bucket empty`);
            return;
        }

        const cutoff  = Date.now() - R2_RETENTION_MS;
        const toDelete = objects
            .filter(o => o.LastModified && o.LastModified.getTime() < cutoff)
            .map(o => ({ Key: o.Key }));

        const totalMB = (objects.reduce((s, o) => s + (o.Size || 0), 0) / 1024 / 1024).toFixed(1);
        console.log(`[${ts()}] R2 cleanup: ${objects.length} objects (${totalMB}MB), ${toDelete.length} to delete`);

        if (!toDelete.length) return;

        // DeleteObjects は1回で最大1000件
        for (let i = 0; i < toDelete.length; i += 1000) {
            const batch = toDelete.slice(i, i + 1000);
            await r2.send(new DeleteObjectsCommand({
                Bucket: R2_BUCKET,
                Delete: { Objects: batch },
            }));
        }
        console.log(`[${ts()}] R2 cleanup: deleted ${toDelete.length} object(s) older than 3 days`);
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

// ── Watch raw/ for new files ───────────────────────────
const pending = new Map();

fs.watch(RAW_DIR, (event, filename) => {
    if (!filename || !/\.(heic|heif|jpg|jpeg|png)$/i.test(filename)) return;

    if (pending.has(filename)) clearTimeout(pending.get(filename));
    pending.set(filename, setTimeout(() => {
        pending.delete(filename);
        const fullPath = path.join(RAW_DIR, filename);
        if (fs.existsSync(fullPath)) {
            console.log(`[${ts()}] new raw file detected: ${filename}`);
            composite(fullPath);
        }
    }, 500));
});

console.log(`[${ts()}] Watching ${RAW_DIR}`);

// ── R2 cleanup スケジュール（起動時 + 1時間ごと）────────
cleanupOldR2Objects();
setInterval(cleanupOldR2Objects, R2_CLEANUP_INTERVAL);

// ── Capture trigger ────────────────────────────────────
let seq = 0;

function trigger() {
    seq++;
    const triggerId = `t-${seq}`;
    const body = JSON.stringify({ triggerId });

    const req = http.request(
        {
            hostname: SWIFT_HOST,
            port:     SWIFT_PORT,
            path:     '/capture',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        },
        (res) => { console.log(`[${ts()}] ${triggerId} → ${res.statusCode}`); }
    );
    req.on('error', (err) => {
        console.error(`[${ts()}] ${triggerId} failed: ${err.message}`);
    });
    req.write(body);
    req.end();
}

console.log(`[${ts()}] Trigger: host=${SWIFT_HOST} port=${SWIFT_PORT} interval=${INTERVAL_MS}ms`);
trigger();
setInterval(trigger, INTERVAL_MS);

// ── Util ───────────────────────────────────────────────
function ts() {
    return new Date().toISOString();
}
