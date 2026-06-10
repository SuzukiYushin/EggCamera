// Dev-only stub for EggCameraMac's TriggerReceiverServer (:8082).
// Accepts POST /capture and, after a short delay, drops a fixture HEIC
// into data/raw/ — simulating the real iPhone capture + upload round trip.
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const { RAW_DIR } = require('../src/config');

const PORT             = parseInt(process.env.FAKE_MAC_PORT  || process.env.SWIFT_PORT || '8082', 10);
const CAPTURE_DELAY_MS = parseInt(process.env.FAKE_MAC_DELAY_MS || '1500', 10);

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const fixtures = fs.readdirSync(FIXTURES_DIR).filter(f => /\.heic$/i.test(f));

if (!fixtures.length) {
    console.error('[fake-mac] no fixtures found in test/fixtures/');
    process.exit(1);
}

fs.mkdirSync(RAW_DIR, { recursive: true });

let counter = 0;

function timestampName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    counter++;
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
        + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
        + `_${String(counter).padStart(3, '0')}.heic`;
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/capture') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let triggerId = '?';
            try { triggerId = JSON.parse(body).triggerId; } catch { /* ignore */ }
            console.log(`[fake-mac] received ${triggerId}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            setTimeout(() => {
                const src  = path.join(FIXTURES_DIR, fixtures[(counter) % fixtures.length]);
                const dest = path.join(RAW_DIR, timestampName());
                fs.copyFileSync(src, dest);
                console.log(`[fake-mac] dropped ${path.basename(dest)}`);
            }, CAPTURE_DELAY_MS);
        });
        return;
    }
    res.writeHead(404);
    res.end();
});

server.listen(PORT, () => {
    console.log(`[fake-mac] listening on :${PORT}, ${fixtures.length} fixture(s), delay=${CAPTURE_DELAY_MS}ms`);
});
