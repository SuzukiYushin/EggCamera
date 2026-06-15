const fs   = require('node:fs');
const path = require('node:path');

const { LOG_DIR } = require('./config');

fs.mkdirSync(LOG_DIR, { recursive: true });

// 構造化ログをファイルに一本化（プロセス横断の単一ソース）。
// admin を別プロセスに分離しても、admin はこの app.jsonl を読めば core のログ/診断ができる。
const MAX_LINES = 2000;
const APP_LOG = path.join(LOG_DIR, 'app.jsonl');

// seq はプロセス再起動をまたいで単調増加させる（管理画面の since ポーリングが巻き戻らないように）。
let seq = 0;
try {
    const lines = fs.readFileSync(APP_LOG, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 100; i--) {
        try { const e = JSON.parse(lines[i]); if (e.seq > seq) seq = e.seq; } catch { /* skip */ }
    }
} catch { /* ファイル未作成 */ }

let writer = null;       // app.jsonl に書くのは1プロセス('core')だけ（seq衝突回避）
let writeCount = 0;

function dailyPath() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(LOG_DIR, `server-${ymd}.log`);
}

function trimAppLog() {
    try {
        const lines = fs.readFileSync(APP_LOG, 'utf8').split('\n').filter(Boolean);
        if (lines.length > MAX_LINES) {
            fs.writeFileSync(APP_LOG, lines.slice(-MAX_LINES).join('\n') + '\n');
        }
    } catch { /* ignore */ }
}

function record(level, args) {
    const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    const entry = { seq: ++seq, time: new Date().toISOString(), level, text };

    // 構造化ログ（同期追記＝seq順を保証。1プロセスのみが書く）
    if (writer === 'core') {
        try { fs.appendFileSync(APP_LOG, JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
        if (++writeCount % 500 === 0) trimAppLog();
    }
    // 人間可読の日次ログ（従来どおり・非同期）
    fs.appendFile(dailyPath(), `${entry.time} [${level}] ${text}\n`, () => {});
}

// console.log/warn/error を横取りしてファイルにも流す。
// role='core'（既定）だけが app.jsonl の書き手。admin など他プロセスは role を別名にする。
function install(role = 'core') {
    writer = role;
    for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            record(level, args);
            orig(...args);
        };
    }
}

// app.jsonl（core が書いた単一ソース）から読む。プロセスを問わず同じ結果。
function getLogs(sinceSeq = 0) {
    let lines;
    try { lines = fs.readFileSync(APP_LOG, 'utf8').split('\n'); }
    catch { return []; }
    const out = [];
    for (const ln of lines) {
        if (!ln) continue;
        try { const e = JSON.parse(ln); if (e.seq > sinceSeq) out.push(e); } catch { /* skip */ }
    }
    return out.slice(-MAX_LINES);
}

module.exports = { install, getLogs };
