const fs   = require('node:fs');
const path = require('node:path');
const { DATA_DIR, ts } = require('./config');

// 運用モード（メンテナンス/ロック）状態。再起動を跨ぐためファイルに永続化する。
const MODE_FILE = path.join(DATA_DIR, 'mode.json');

function load() {
    try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); }
    catch { return { maintenance: false, runSelfTestOnBoot: false, reason: '' }; }
}
function save(m) {
    try { fs.writeFileSync(MODE_FILE, JSON.stringify(m)); } catch { /* ignore */ }
}

function get() { return load(); }
function isMaintenance() { return !!load().maintenance; }

// メンテナンス開始（キオスクUIをロック）。runSelfTestOnBoot=true なら次回起動時に自動セルフテスト
function startMaintenance({ reason = '', runSelfTestOnBoot = false } = {}) {
    const m = { maintenance: true, runSelfTestOnBoot, reason };
    save(m);
    console.log(`[${ts()}] maintenance ON (${reason})`);
    return m;
}

// メンテナンス解除（ユーザー操作受付を再開）
function stopMaintenance() {
    save({ maintenance: false, runSelfTestOnBoot: false, reason: '' });
    console.log(`[${ts()}] maintenance OFF (resume)`);
    return load();
}

function clearSelfTestFlag() {
    const m = load();
    m.runSelfTestOnBoot = false;
    save(m);
}

module.exports = { get, isMaintenance, startMaintenance, stopMaintenance, clearSelfTestFlag };
