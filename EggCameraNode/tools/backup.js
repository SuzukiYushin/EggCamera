#!/usr/bin/env node
// 設定・フレームの日次バックアップ。
// ・ローカル: 機密込み(.env等)も含めた tar を data/backups/ に世帯数で保持
// ・R2: 機密を除いた frames + settings を backups/ プレフィックスへ（SSD故障に備えオフサイト）
const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { DATA_DIR, FRAMES_DIR, SETTINGS_PATH, ts } = require('../src/config');
const { uploadFileToR2 } = require('../src/composite');
const slack = require('../src/slack');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_LOCAL = 14;
const REPO = path.resolve(__dirname, '../..');

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tag = stamp();

    // 1) ローカル全体バックアップ（機密込み）— tar は相対パスで固める
    const fullTar = path.join(BACKUP_DIR, `full-${tag}.tgz`);
    const items = [
        'EggCameraNode/.env',
        '.env.slack', '.env.cloudflare', '.env.watchdog',
        'data/assets/frames',
        'data/settings.json',
        'EggCameraMac/config.json',
    ].filter(rel => fs.existsSync(path.join(REPO, rel)));
    execFileSync('tar', ['-czf', fullTar, '-C', REPO, ...items]);
    console.log(`[${ts()}] local backup → ${path.basename(fullTar)} (${items.length} items)`);

    // ローカル世帯数を保つ
    const fulls = fs.readdirSync(BACKUP_DIR).filter(f => /^full-.*\.tgz$/.test(f)).sort();
    for (const f of fulls.slice(0, Math.max(0, fulls.length - KEEP_LOCAL))) {
        try { fs.rmSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }

    // 2) R2 へ（機密を除く: frames + settings のみ）
    const safeTar = path.join(BACKUP_DIR, `config-${tag}.tgz`);
    const safeItems = ['data/assets/frames', 'data/settings.json'].filter(rel => fs.existsSync(path.join(REPO, rel)));
    execFileSync('tar', ['-czf', safeTar, '-C', REPO, ...safeItems]);
    try {
        await uploadFileToR2(safeTar, `backups/config-${tag}.tgz`, 'application/gzip');
        fs.rmSync(safeTar, { force: true });
    } catch (err) {
        console.error(`[${ts()}] backup R2 upload failed: ${err.message}`);
        slack.notify(`設定バックアップのR2アップロードに失敗しました: ${err.message}`,
            { level: 'warn', key: 'backup-fail', throttleMs: 12 * 60 * 60_000 });
    }
}

main().catch(err => {
    console.error(`[${ts()}] backup failed: ${err.message}`);
    slack.notify(`日次バックアップに失敗しました: ${err.message}`,
        { level: 'warn', key: 'backup-fail', throttleMs: 12 * 60 * 60_000 });
    process.exit(1);
});
