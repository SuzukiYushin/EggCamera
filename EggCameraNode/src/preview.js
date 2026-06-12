// iPhone のライブプレビューフレームを中継する。
// iPhone は _eggcamera._tcp を Bonjour で公開しており、:8080 の GET /frame が
// 最新のJPEGを返す。ここでは Bonjour でアドレスを発見・キャッシュし、
// /api/preview/frame からプロキシする。
const http = require('node:http');
const { Bonjour } = require('bonjour-service');

const { ts } = require('./config');

let iphone = null;          // { host, port }
let browsing = false;
let lastLoggedHost = null;

function startDiscovery() {
    if (browsing) return;
    browsing = true;
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'eggcamera', protocol: 'tcp' });

    browser.on('up', service => {
        const host = service.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || service.addresses?.[0];
        if (!host) return;
        iphone = { host, port: service.port || 8080 };
        if (lastLoggedHost !== host) {
            lastLoggedHost = host;
            console.log(`[${ts()}] preview: iPhone discovered at ${host}:${iphone.port}`);
        }
    });

    browser.on('down', () => {
        console.log(`[${ts()}] preview: iPhone service down`);
        iphone = null;
        lastLoggedHost = null;
    });

    // 取りこぼし対策で定期再検索
    setInterval(() => { try { browser.update(); } catch { /* ignore */ } }, 15_000);
}

// 最新フレームを1枚取得して res にそのまま流す
function proxyFrame(req, res) {
    if (!iphone) {
        return res.status(503).json({ error: 'iphone_not_found' });
    }
    const upstream = http.get({
        host: iphone.host,
        port: iphone.port,
        path: '/frame',
        timeout: 3000,
    }, up => {
        if (up.statusCode !== 200) {
            up.resume();
            return res.status(502).json({ error: `iphone_status_${up.statusCode}` });
        }
        res.set({
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-store',
        });
        up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', err => {
        if (!res.headersSent) res.status(502).json({ error: 'iphone_unreachable' });
        // 接続不能ならキャッシュを破棄して再探索に任せる
        if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') iphone = null;
    });
}

module.exports = { startDiscovery, proxyFrame };
