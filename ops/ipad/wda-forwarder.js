// WDA Wi-Fi フォワーダ: 127.0.0.1:18100 -> 192.168.11.104:8100
// launchd 起動 Appium のローカルネットワーク権限ブロックを回避するため、
// シェル権限のプロセスが iPad への接続を中継する。
const net = require('net');
const TARGET_HOST = process.env.IPAD_IP || '192.168.11.104';  // remote-control.sh が実IPを渡してくる
const TARGET_PORT = 8100;
const LISTEN_PORT = 18100;

const server = net.createServer((client) => {
    const upstream = net.connect(TARGET_PORT, TARGET_HOST);
    client.pipe(upstream);
    upstream.pipe(client);
    const cleanup = () => { client.destroy(); upstream.destroy(); };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`[wda-forwarder] 127.0.0.1:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
server.on('error', (e) => { console.error('[wda-forwarder] ' + e.message); process.exit(1); });
