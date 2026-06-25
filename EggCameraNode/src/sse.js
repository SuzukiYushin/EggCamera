'use strict';
// SSE クライアント管理。server.js が /api/events に登録し、
// admin プロセスからの reload-signal で broadcast する。

const clients = new Set();

function addClient(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.add(res);
    // SSE コメント行(': hb')を ~25秒毎に送出し、Cloudflare(Tunnel/Pages)経由での
    // idle timeout による切断を防ぐ。コメント行は EventSource に無視されイベントを
    // 発火しないため App.tsx の settings-changed リスナに無害。ローカル iPad 直叩き運用にも影響なし。
    const heartbeat = setInterval(() => {
        try { res.write(': hb\n\n'); } catch { /* already closed */ }
    }, 25000);
    res.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
    });
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${data ?? ''}\n\n`;
    for (const res of clients) {
        res.write(payload);
    }
}

function clientCount() { return clients.size; }

module.exports = { addClient, broadcast, clientCount };
