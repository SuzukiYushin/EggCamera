// iPhone のライブプレビューフレームを中継する。
//
// 設計（負荷の脱・掛け算化）:
//   従来はクライアントが各自で /api/preview/frame を高頻度ポーリングしていたため、
//   iPhone:8080/frame への取得が「視聴者数 × fps」で膨張していた。これを避けるため、
//   node 側に単一の取得ループを持ち（iPhone へは常に最大 ~POLL_MS 間隔の1本だけ）、
//   最新フレームをメモリにキャッシュして全クライアントへ fan-out する:
//     - /api/preview/stream … multipart/x-mixed-replace(MJPEG)。<img src> が直接表示。
//     - /api/preview/frame  … 単写真(後方互換)。キャッシュを返すので iPhone へ直撃しない。
//   どちらの方式でも iPhone への取得は単一ループ1本に集約される（視聴者数と無関係に一定）。
//   誰も見ていなければ取得ループは停止する（iPhone 負荷ゼロ）。
//
// USB設計: iPhone:8080 は Mac 上の iproxy(usbmuxd) により localhost:8080 へ USB 経由で
//   フォワードされる（WiFi/Bonjour 非依存）。接続先は config.js に一元化。
const http = require('node:http');

const { IPHONE_HOST, IPHONE_PORT } = require('./config');

const POLL_MS     = 125;   // 単一取得ループの間隔（~8fps）
const STALE_MS    = 3000;  // 上流取得がこの時間失敗し続けたらキャッシュを無効扱い
const KEEPWARM_MS = 5000;  // 最後のアクセスからこの間は取得ループを回し続ける
const MAX_CLIENTS = 24;    // 同時 MJPEG 接続の上限（ソケット/メモリ枯渇 DoS の防止）
const BOUNDARY    = 'eggcameraframe';

let latest   = null; // 直近フレーム(Buffer)
let latestAt = 0;    // 直近の取得成功時刻(ms)
let lastAccess = 0;  // 最後にプレビューが要求された時刻(ms)
let polling  = false;
const clients = new Set(); // MJPEG ストリーム接続中の res

// iPhone から1枚だけ取得（Promise<Buffer>）
function fetchOne() {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: IPHONE_HOST, port: IPHONE_PORT, path: '/frame', timeout: 3000 }, up => {
            if (up.statusCode !== 200) { up.resume(); return reject(new Error(`status_${up.statusCode}`)); }
            const chunks = [];
            up.on('data', c => chunks.push(c));
            up.on('end', () => resolve(Buffer.concat(chunks)));
            up.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// multipart/x-mixed-replace の1パートを書き込む
function writeFrame(res, buf) {
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write('\r\n');
}

function broadcast(buf) {
    for (const res of clients) {
        try { writeFrame(res, buf); } catch { dropClient(res); }
    }
}

function dropClient(res) {
    clients.delete(res);
    try { res.end(); } catch { /* already closed */ }
}

function dropAllClients() {
    for (const res of [...clients]) dropClient(res);
}

// 視聴者がいる間だけ iPhone を取得する単一ループ。
// 取得した最新フレームはキャッシュし、MJPEG クライアントへ即 fan-out する。
function startPolling() {
    if (polling) return;
    polling = true;
    const loop = async () => {
        // ストリーム接続も無く、単写真アクセスも途絶えたら停止（iPhone 負荷ゼロ）
        if (clients.size === 0 && Date.now() - lastAccess > KEEPWARM_MS) { polling = false; return; }
        try {
            const buf = await fetchOne();
            latest = buf; latestAt = Date.now();
            broadcast(buf);
        } catch {
            // 上流ダウンが続いたら MJPEG クライアントを切ってフロント側に fallback させる
            if (Date.now() - latestAt > STALE_MS) dropAllClients();
        }
        if (polling) setTimeout(loop, POLL_MS);
    };
    setTimeout(loop, 0);
}

// MJPEG ストリーム。<img src="/api/preview/stream"> が直接表示できる。
// 1クライアント=1接続で、単一取得ループの最新フレームを共有 fan-out する。
function streamFrames(req, res) {
    if (clients.size >= MAX_CLIENTS) { // 同時接続上限（ソケット/メモリ枯渇の防止）
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
        return res.end('too_many_preview_streams');
    }
    res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close',
    });
    clients.add(res);
    lastAccess = Date.now();
    if (latest && Date.now() - latestAt < STALE_MS) writeFrame(res, latest); // 接続直後に最新を1枚
    startPolling();
    const cleanup = () => dropClient(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
}

// 単写真取得（後方互換: 旧フロント / api-soak / MJPEG非対応ブラウザの fallback 等）。
// 取得ループのキャッシュを返すため、何クライアントが叩いても iPhone への取得は単一ループ1本に集約される。
function proxyFrame(req, res) {
    lastAccess = Date.now();
    startPolling(); // 単写真ポーリングでも取得ループを温め続ける
    if (latest && Date.now() - latestAt < STALE_MS) {
        res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(latest);
    }
    // まだキャッシュが無ければ1枚だけ即時取得して返す
    fetchOne()
        .then(buf => {
            latest = buf; latestAt = Date.now();
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
            res.end(buf);
        })
        .catch(() => { if (!res.headersSent) res.status(502).json({ error: 'iphone_unreachable' }); });
}

// USB直結固定のため探索は不要（互換のため空実装を残す）。
function startDiscovery() { /* USB直結: 探索不要 */ }

// iPad のスタート押下時に、iPhone のカメラを先行起動させる（撮影ページの
// 待ち時間をなくすため）。投げっぱなしで良く、失敗しても撮影時の遅延起動が保険になる。
function wake() {
    const req = http.request({
        host: IPHONE_HOST, port: IPHONE_PORT, path: '/wake', method: 'POST', timeout: 2000,
    }, r => r.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* 起動できなくても撮影時に遅延起動する */ });
    req.end();
    return true;
}

module.exports = { startDiscovery, proxyFrame, streamFrames, wake };
