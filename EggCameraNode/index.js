const fs     = require('node:fs');
const http   = require('node:http');
const os     = require('node:os');
const path   = require('node:path');
const { execFile } = require('node:child_process');
const sharp  = require('sharp');

// ── Paths ──────────────────────────────────────────────
const DATA_DIR       = path.resolve(__dirname, '../data');
const RAW_DIR        = path.join(DATA_DIR, 'raw');
const COMPOSITED_DIR = path.join(DATA_DIR, 'composited');
const FLAME_PATH     = path.join(DATA_DIR, 'assets/frames/flame_sample.png');

// ── Trigger config ─────────────────────────────────────
const SWIFT_HOST  = process.env.SWIFT_HOST  || 'localhost';
const SWIFT_PORT  = parseInt(process.env.SWIFT_PORT  || '8082', 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '5000', 10);

// ── Ensure output dir exists ───────────────────────────
fs.mkdirSync(COMPOSITED_DIR, { recursive: true });

// ── Composite ──────────────────────────────────────────
function heicToJpeg(srcPath, destPath) {
    return new Promise((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath],
            (err) => err ? reject(err) : resolve());
    });
}

async function composite(rawPath) {
    const fileName = path.basename(rawPath, path.extname(rawPath));
    const destPath = path.join(COMPOSITED_DIR, `${fileName}.jpg`);
    const tmpPath  = path.join(os.tmpdir(), `eggcamera_${fileName}.jpg`);

    try {
        await heicToJpeg(rawPath, tmpPath);

        const base = sharp(tmpPath);
        const meta = await base.metadata();
        const flame = await sharp(FLAME_PATH)
            .resize(meta.width, meta.height, { fit: 'fill' })
            .toBuffer();

        await base
            .composite([{ input: flame, blend: 'over' }])
            .jpeg({ quality: 95 })
            .toFile(destPath);

        console.log(`[${ts()}] composite saved → ${path.basename(destPath)}`);
    } catch (err) {
        console.error(`[${ts()}] composite failed for ${path.basename(rawPath)}: ${err.message}`);
    } finally {
        fs.rm(tmpPath, { force: true }, () => {});
    }
}

// ── Watch raw/ for new files ───────────────────────────
// Use a short settle delay to ensure Swift has finished writing before we read.
const pending = new Map();

fs.watch(RAW_DIR, (event, filename) => {
    if (!filename || !/\.(heic|heif|jpg|jpeg|png)$/i.test(filename)) return;

    // debounce per file
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

// ── Capture trigger ────────────────────────────────────
let seq = 0;

function trigger() {
    seq++;
    const triggerId = `t-${seq}`;
    const body = JSON.stringify({ triggerId });

    const req = http.request(
        {
            hostname: SWIFT_HOST,
            port: SWIFT_PORT,
            path: '/capture',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        },
        (res) => {
            console.log(`[${ts()}] ${triggerId} → ${res.statusCode}`);
        }
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
