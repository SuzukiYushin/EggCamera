// iPhone のライブプレビューフレームを中継する。
// USB設計: iPhone:8080 は Mac 上の iproxy(usbmuxd) により localhost:8080 へ
// USB経由でフォワードされる。WiFi/Bonjour には依存しない（IP漂流・WiFi断の影響を受けない）。
// 接続先は config.js に一元化（IPHONE_HOST/IPHONE_PORT、env上書き可）。
const http = require('node:http');

const { IPHONE_HOST, IPHONE_PORT } = require('./config');

// USB直結固定のため探索は不要（互換のため空実装を残す）。
function startDiscovery() { /* USB直結: 探索不要 */ }

// 最新フレームを1枚取得して res にそのまま流す
function proxyFrame(req, res) {
    const upstream = http.get({
        host: IPHONE_HOST,
        port: IPHONE_PORT,
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
    upstream.on('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'iphone_unreachable' });
    });
}

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

module.exports = { startDiscovery, proxyFrame, wake };
