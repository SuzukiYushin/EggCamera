#!/usr/bin/env node
// モデル非依存の番犬: 長期運用テストの最新スナップショットを読み、
// 想定外/コスト警告/サーバ無応答/停滞/DL失敗 が「増えた」ら Slack 通知する。
// Claude監視ループが落ちていても検知だけは継続する目的。launchdから定期実行。
//
// 本番運用（拡張なし）では [TEST] スナップショットが出ないので原則無通知。
// 本番の異常検知はサーバ側のSlack通知（失敗画像/課金/ディスク/未捕捉/起動時）が担う。
const fs   = require('node:fs');
const path = require('node:path');

const { LOG_DIR, DATA_DIR, ts } = require('../src/config');
const slack = require('../src/slack');

const STATE = path.join(DATA_DIR, '.soak-watch-state.json');
const WATCH = ['想定外', 'コスト警告', 'サーバ無応答', '停滞']; // 増えたら通知
const SNAPSHOT_STALE_MIN = 20; // 直近スナップショットがこれ以上古ければテスト停止扱い

function latestLogFile() {
    let files;
    try { files = fs.readdirSync(LOG_DIR).filter(f => /^server-\d+\.log$/.test(f)); } catch { return null; }
    if (!files.length) return null;
    return files.map(f => ({ f, m: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].f;
}

// 最新の「統計:」行をパースして {counts, time} を返す
function latestSnapshot() {
    const lf = latestLogFile();
    if (!lf) return null;
    const lines = fs.readFileSync(path.join(LOG_DIR, lf), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!/\[TEST\].*統計:/.test(lines[i])) continue;
        const line = lines[i];
        const num = label => {
            const m = line.match(new RegExp(label + '([0-9]+)'));
            return m ? parseInt(m[1], 10) : null;
        };
        const timeM = line.match(/^(\S+)/);
        return {
            time: timeM ? Date.parse(timeM[1]) : Date.now(),
            counts: {
                'サイクル': num('サイクル'), 'DL失敗': num('失敗'),
                '想定外': num('想定外'), 'コスト警告': num('コスト警告'),
                'サーバ無応答': num('サーバ無応答'), '停滞': num('停滞'),
            },
        };
    }
    return null;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch { /* ignore */ } }

const snap = latestSnapshot();
if (!snap) { console.log(`[${ts()}] soak-watch: スナップショットなし（テスト未稼働）`); process.exit(0); }

const prev = loadState();
const c = snap.counts;

// 1) 監視カウンタが増えたら通知（想定外/コスト警告/サーバ無応答/停滞）
const ups = [];
for (const k of WATCH) {
    const now = c[k] ?? 0, was = prev.counts?.[k] ?? now;
    if (now > was) ups.push(`${k} +${now - was}（計${now}）`);
}
// DL失敗も増分監視
{
    const now = c['DL失敗'] ?? 0, was = prev.counts?.['DL失敗'] ?? now;
    if (now > was) ups.push(`DL失敗 +${now - was}（計${now}）`);
}
if (ups.length) {
    slack.notify(`長期運用テストで要注意の増加: ${ups.join(' / ')}。Claude監視が止まっている場合は調査してください。`,
        { level: 'warn', key: 'soak-watch-up', throttleMs: 10 * 60_000 });
    console.log(`[${ts()}] soak-watch ALERT: ${ups.join(', ')}`);
}

// 2) テスト稼働中だったのにスナップショットが途絶えた（拡張/タブレットが停止）
const ageMin = (Date.now() - snap.time) / 60000;
if (prev.lastSnapshotTime && ageMin > SNAPSHOT_STALE_MIN) {
    slack.notify(`長期運用テストのスナップショットが ${Math.round(ageMin)} 分途絶えています。タブレットの拡張が停止した可能性。`,
        { level: 'warn', key: 'soak-stalled', throttleMs: 30 * 60_000 });
    console.log(`[${ts()}] soak-watch: snapshot stale ${Math.round(ageMin)}min`);
}

saveState({ counts: c, lastSnapshotTime: snap.time });
if (!ups.length) console.log(`[${ts()}] soak-watch OK: ${JSON.stringify(c)}`);
