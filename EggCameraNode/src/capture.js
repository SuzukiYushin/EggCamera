const fs   = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { RAW_DIR, PREVIEW_DIR, SWIFT_HOST, SWIFT_PORT } = require('./config');

const RAW_FILE_RE = /\.(heic|heif|jpg|jpeg|png)$/i;

let seq = 0;

// ── Send an on-demand capture trigger to the Mac (TriggerReceiverServer) ──
function sendTrigger() {
    return new Promise((resolve, reject) => {
        seq++;
        const body = JSON.stringify({ triggerId: `t-${seq}` });

        const req = http.request({
            hostname: SWIFT_HOST,
            port:     SWIFT_PORT,
            path:     '/capture',
            method:   'POST',
            timeout:  5_000, // 接続できても応答しないMacで永久ブロックしないように
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            res.resume();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
            } else {
                reject(new Error('mac-unreachable'));
            }
        });

        req.on('error', () => reject(new Error('mac-unreachable')));
        req.on('timeout', () => req.destroy(new Error('mac-unreachable')));
        req.write(body);
        req.end();
    });
}

// ── Wait for a new file to land in data/raw/ after `sinceMs` ──────────────
function waitForNewRawFile(sinceMs, timeoutMs) {
    return new Promise((resolve, reject) => {
        const start = Date.now();

        const findCandidate = () => {
            let entries;
            try {
                entries = fs.readdirSync(RAW_DIR, { withFileTypes: true });
            } catch {
                return null;
            }
            for (const entry of entries) {
                if (!entry.isFile() || !RAW_FILE_RE.test(entry.name)) continue;
                const fullPath = path.join(RAW_DIR, entry.name);
                let stat;
                try { stat = fs.statSync(fullPath); } catch { continue; }
                if (stat.mtimeMs > sinceMs) return fullPath;
            }
            return null;
        };

        const poll = () => {
            const candidate = findCandidate();
            if (!candidate) {
                if (Date.now() - start >= timeoutMs) return reject(new Error('capture-timeout'));
                setTimeout(poll, 500);
                return;
            }
            // settle: make sure the file isn't still being written
            const size1 = fs.statSync(candidate).size;
            setTimeout(() => {
                let size2;
                try { size2 = fs.statSync(candidate).size; } catch { size2 = -1; }
                if (size2 === size1 && size2 > 0) {
                    resolve(candidate);
                } else if (Date.now() - start >= timeoutMs) {
                    reject(new Error('capture-timeout'));
                } else {
                    setTimeout(poll, 300);
                }
            }, 300);
        };

        poll();
    });
}

// ── HEIC → JPEG via macOS sips ─────────────────────────────────────────────
function heicToJpeg(srcPath, destPath) {
    return new Promise((resolve, reject) => {
        execFile('sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath],
            (err) => err ? reject(err) : resolve());
    });
}

// ── Ensure a browser-viewable JPEG preview exists for a raw photo ─────────
async function ensurePreviewJpeg(rawPath) {
    const ext = path.extname(rawPath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return rawPath;

    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const base = path.basename(rawPath, path.extname(rawPath));
    const previewPath = path.join(PREVIEW_DIR, `${base}.jpg`);
    if (!fs.existsSync(previewPath)) {
        await heicToJpeg(rawPath, previewPath);
    }
    return previewPath;
}

module.exports = {
    sendTrigger,
    waitForNewRawFile,
    heicToJpeg,
    ensurePreviewJpeg,
};
