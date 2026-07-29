const fs   = require('node:fs');
const path = require('node:path');

const { LOG_DIR } = require('./config');

fs.mkdirSync(LOG_DIR, { recursive: true });

// 構造化ログをファイルに一本化（プロセス横断の単一ソース）。
// admin を別プロセスに分離しても、admin はこの app.jsonl を読めば core のログ/診断ができる。
const MAX_LINES = 2000;
const MAX_APP_BYTES = 20 * 1024 * 1024;   // app.jsonl のバイト上限（巨大行スパイクで2000行でも膨張するのを抑える）
const MAX_DAILY_BYTES = 20 * 1024 * 1024; // 日次ログのバイト上限（EPIPEループ等の暴発で1日124M級になるのを抑える）
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
        let lines = fs.readFileSync(APP_LOG, 'utf8').split('\n').filter(Boolean);
        const overLines = lines.length > MAX_LINES;
        if (overLines) lines = lines.slice(-MAX_LINES);
        // バイト上限: 末尾(新しい方)から積み上げ、20MB を超えたら古い行を捨てる（巨大行スパイク対策）。
        let total = 0, cut = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            total += Buffer.byteLength(lines[i]) + 1; // +1 は改行
            if (total > MAX_APP_BYTES) { cut = i + 1; break; }
        }
        if (cut > 0) lines = lines.slice(cut);
        if (overLines || cut > 0) {
            fs.writeFileSync(APP_LOG, lines.length ? lines.join('\n') + '\n' : '');
        }
    } catch { /* ignore */ }
}

// 日次ログ(server-YYYYMMDD.log)が 20MB を超えたら、直近 20MB だけ残して切り詰める。
// 124M 級でも全読みせず末尾だけ readSync するので軽量。先頭の途中行は最初の改行で捨てる。
function trimDailyLog() {
    try {
        const p = dailyPath();
        const sz = fs.statSync(p).size;
        if (sz <= MAX_DAILY_BYTES) return;
        const fd = fs.openSync(p, 'r');
        try {
            const buf = Buffer.allocUnsafe(MAX_DAILY_BYTES);
            fs.readSync(fd, buf, 0, MAX_DAILY_BYTES, sz - MAX_DAILY_BYTES);
            const nl = buf.indexOf(0x0a); // 先頭の途中行を捨て、行頭からにそろえる
            fs.writeFileSync(p, nl >= 0 ? buf.subarray(nl + 1) : buf);
        } finally {
            fs.closeSync(fd);
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
        if (++writeCount % 500 === 0) { trimAppLog(); trimDailyLog(); }
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
