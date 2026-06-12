const fs   = require('node:fs');
const path = require('node:path');

const { LOG_DIR } = require('./config');

fs.mkdirSync(LOG_DIR, { recursive: true });

// メモリ上のリングバッファ（管理画面のログタブ用）＋日次ファイル追記
const MAX_LINES = 2000;
const buffer = [];   // { seq, time, level, text }
let seq = 0;

function logFilePath() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(LOG_DIR, `server-${ymd}.log`);
}

function record(level, args) {
    const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    const entry = { seq: ++seq, time: new Date().toISOString(), level, text };
    buffer.push(entry);
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
    fs.appendFile(logFilePath(), `${entry.time} [${level}] ${text}\n`, () => {});
}

// console.log/warn/error を横取りしてバッファにも流す
function install() {
    for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            record(level, args);
            orig(...args);
        };
    }
}

function getLogs(sinceSeq = 0) {
    return buffer.filter(e => e.seq > sinceSeq);
}

module.exports = { install, getLogs };
