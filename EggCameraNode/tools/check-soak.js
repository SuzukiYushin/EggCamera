#!/usr/bin/env node
// 長期運用テストの直近ログを要約する。/loop の監視ループから呼ぶ。
// 直近 N 分の [TEST] / [CLIENT] / error 行を拾い、アラートを分類して出力する。
// 終了コード: 異常あり=1 / 正常=0 （ループ側が分岐しやすいように）

const fs = require('node:fs');
const path = require('node:path');

const WINDOW_MIN = parseInt(process.argv[2] || '30', 10);
// ログ(/api/admin/logs)は admin 別プロセス(:3001)が配信する（core からファイル app.jsonl を読む）。
const ADMIN_PORT = process.env.ADMIN_PORT || '3001';

// 管理APIに ADMIN_TOKEN が設定されていればヘッダで渡す（同階層の ../.env から読む）。
function readAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^ADMIN_TOKEN=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const ADMIN_TOKEN = readAdminToken();

(async () => {
  let logs;
  try {
    const headers = ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {};
    const res = await fetch(`http://localhost:${ADMIN_PORT}/api/admin/logs?since=0`, { headers });
    logs = await res.json();
  } catch (err) {
    console.log(`SERVER_UNREACHABLE: ${err.message}`);
    process.exit(1);
  }

  const cutoff = Date.now() - WINDOW_MIN * 60_000;
  const recent = logs.filter(e => new Date(e.time).getTime() >= cutoff);

  const alerts = recent.filter(e =>
    e.level === 'error' || /\[TEST\].*[▲△]/.test(e.text) || /\[CLIENT/.test(e.text));
  const testLines = recent.filter(e => /\[TEST\]/.test(e.text));
  const lastSnapshot = [...testLines].reverse().find(e => /統計:/.test(e.text));
  // メインスレッドからの申し送り。アラートではないが必ず表示する
  const markers = recent.filter(e => /DEPLOY-MARKER|NOTE-TO-LOOP/.test(e.text));

  console.log(`=== soak check (直近${WINDOW_MIN}分) ===`);
  console.log(`ログ行: ${recent.length} / うちTEST: ${testLines.length} / 要注意: ${alerts.length}`);
  if (lastSnapshot) console.log(`最新スナップショット: ${lastSnapshot.text.replace(/^\[[^\]]+\]\s*\[TEST\]\s*/, '')}`);
  else console.log('最新スナップショット: なし（テスト未稼働の可能性）');

  if (markers.length) {
    console.log('\n--- メインスレッドからの申し送り（異常ではない） ---');
    for (const e of markers) {
      console.log(`${e.time.slice(11, 19)} ${e.text.replace(/^\[[^\]]+\]\s*\[TEST\]\s*/, '')}`);
    }
  }

  if (alerts.length) {
    console.log('\n--- 要注意ログ ---');
    for (const e of alerts.slice(-40)) {
      console.log(`${e.time.slice(11, 19)} [${e.level}] ${e.text.replace(/^\[[^\]]+\]\s*/, '').slice(0, 160)}`);
    }
  }

  process.exit(alerts.length ? 1 : 0);
})();
