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
    res.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${data ?? ''}\n\n`;
    for (const res of clients) {
        res.write(payload);
    }
}

function clientCount() { return clients.size; }

module.exports = { addClient, broadcast, clientCount };
