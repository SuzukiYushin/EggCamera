// EggCamera 運用アクション（Slackから呼ぶ実体）。
// Slackに依存しないので CLI からも `node bot.js test <cmd>` で検証できる。
const { execFile } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const NODE_DIR = path.join(REPO, 'EggCameraNode');
const IPHONE_DIR = path.join(REPO, 'EggCameraIPhone');
const SERVER = 'http://localhost:3000';
const IPHONE_FRAME = process.env.IPHONE_FRAME_URL || 'http://192.168.10.109:8080/frame';
const WATCHDOG_URL = process.env.WATCHDOG_URL || '';
const UID = process.getuid ? process.getuid() : null;

function sh(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 120_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: (stdout || '') + (stderr || '') });
    });
  });
}

async function httpCode(url, ms = 5000) {
  const r = await sh('curl', ['-s', '-o', '/dev/null', '-m', String(ms / 1000), '-w', '%{http_code}', url]);
  return r.out.trim();
}
async function httpJson(url, ms = 5000) {
  const r = await sh('curl', ['-s', '-m', String(ms / 1000), url]);
  try { return JSON.parse(r.out); } catch { return null; }
}

// テスト環境の監視へ申し送り（再起動系の前後で必ず投稿）
async function postMarker(text) {
  await sh('curl', ['-s', '-X', 'POST', `${SERVER}/api/test-report`,
    '-H', 'Content-Type: application/json',
    '--data', JSON.stringify({ level: 'info', text: `DEPLOY-MARKER(slack-bot): ${text}` })]);
}

async function launchctlKickstart(label) {
  return sh('launchctl', ['kickstart', '-k', `gui/${UID}/${label}`]);
}

// ── 状況確認 ──────────────────────────────────────────
async function status() {
  const [nodeCode, iphoneCode, disk, failed, metrics] = await Promise.all([
    httpCode(SERVER + '/'),
    httpCode(IPHONE_FRAME),
    httpJson(SERVER + '/api/admin/disk'),
    httpJson(SERVER + '/api/admin/failed'),
    httpJson(SERVER + '/api/admin/metrics'),
  ]);
  const gb = n => n != null ? (n / 1073741824).toFixed(1) + 'GB' : '?';
  const jobs = await sh('launchctl', ['list']);
  const jobState = label => {
    const line = jobs.out.split('\n').find(l => l.includes(label));
    if (!line) return '未登録';
    const pid = line.trim().split(/\s+/)[0];
    return pid === '-' ? '停止' : `稼働(pid ${pid})`;
  };
  let watchdog = '—';
  if (WATCHDOG_URL) {
    const w = await httpJson(WATCHDOG_URL);
    watchdog = w && w.ageSec != null ? `${w.ageSec}秒前にビート` : '応答なし';
  }
  const ok = c => c === '200' ? '✅' : '⚠️';
  const lines = [
    '*EggCamera 状況*',
    `• Nodeサーバ :3000 … ${ok(nodeCode)} ${nodeCode}`,
    `• iPhone :8080/frame … ${ok(iphoneCode)} ${iphoneCode}`,
    `• ディスク空き … ${disk ? gb(disk.freeBytes) : '?'}`,
    `• 失敗画像 … ${Array.isArray(failed) ? failed.length : '?'} 件`,
    `• メモリ rss … ${metrics ? metrics.rssMB + 'MB / load ' + (metrics.loadavg?.[0] ?? '?') : '?'}`,
    `• 死活監視ビート … ${watchdog}`,
    `• 常駐 … node:${jobState('com.eggcamera.node')} / mac:${jobState('com.eggcamera.mac')}`,
  ];
  return lines.join('\n');
}

// ── 再起動系（前後にマーカー＆復旧確認） ───────────────
async function restartNode() {
  await postMarker('Slackからnodeサーバを再起動します。一時的なAPI断・セッションリセットは本操作由来で異常ではありません。');
  await launchctlKickstart('com.eggcamera.node');
  await new Promise(r => setTimeout(r, 3000));
  const code = await httpCode(SERVER + '/');
  await postMarker(`node再起動完了 :3000=${code}。以降正常。`);
  return code === '200' ? '✅ nodeサーバ再起動OK（:3000=200）' : `⚠️ 再起動後 :3000=${code}`;
}

async function restartMac() {
  await postMarker('SlackからEggCameraMacを再起動します。撮影トリガ断は本操作由来で異常ではありません。');
  await launchctlKickstart('com.eggcamera.mac');
  await new Promise(r => setTimeout(r, 3000));
  const ports = await sh('bash', ['-lc', "lsof -nP -iTCP:8081 -iTCP:8082 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN"]);
  const n = parseInt(ports.out.trim(), 10) || 0;
  await postMarker(`EggCameraMac再起動完了 待受${n}ポート。`);
  return n >= 2 ? '✅ EggCameraMac再起動OK（:8081/8082 待受）' : `⚠️ 待受ポート ${n}（2が正常）`;
}

async function restartIphone() {
  await postMarker('SlackからiPhoneアプリを再起動します。数サイクルのcapture断は本操作由来で異常ではありません。');
  const r = await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['restart'], { cwd: IPHONE_DIR });
  await new Promise(r => setTimeout(r, 5000));
  const code = await httpCode(IPHONE_FRAME);
  await postMarker(`iPhone再起動 :8080/frame=${code}。`);
  return code === '200' ? '✅ iPhone再起動OK（:8080/frame=200）'
    : `⚠️ 再起動後 :8080=${code}\n${r.out.slice(-300)}`;
}

// iPhone「本体」再起動（破壊的: パスコード有りだと復帰後ロックされる）
async function rebootIphone() {
  await postMarker('SlackからiPhone本体を再起動します。1〜2分のcapture/プレビュー断は本操作由来で異常ではありません。');
  const r = await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['reboot'], { cwd: IPHONE_DIR, timeout: 300_000 });
  await new Promise(r => setTimeout(r, 8000));
  const code = await httpCode(IPHONE_FRAME);
  await postMarker(`iPhone本体再起動 :8080/frame=${code}。`);
  return code === '200'
    ? '✅ iPhone本体を再起動し、アプリ復帰OK（:8080/frame=200）'
    : `⚠️ 再起動後 :8080=${code}。パスコード有りだと端末がロックされ手動解除が必要です。\n${r.out.slice(-300)}`;
}

async function refreshIphone() {
  await postMarker('SlackからiPhoneアプリを再ビルド・再インストール・再起動します（プロファイル更新）。数サイクルのcapture断は本操作由来で異常ではありません。');
  const r = await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['refresh'], { cwd: IPHONE_DIR, timeout: 420_000 });
  await new Promise(r => setTimeout(r, 5000));
  const code = await httpCode(IPHONE_FRAME);
  await postMarker(`iPhone refresh完了 :8080/frame=${code}。`);
  return code === '200' ? '✅ iPhone refresh OK（再ビルド→入れ直し→:8080=200）'
    : `⚠️ refresh後 :8080=${code}\n${r.out.slice(-400)}`;
}

async function logs(n = 20) {
  const arr = await httpJson(`${SERVER}/api/admin/logs?since=0`);
  if (!Array.isArray(arr)) return 'ログ取得失敗';
  // 実害のあるエラーだけ（テストの統計スナップショットや申し送りマーカーは除外）
  const isReal = e =>
    !/統計:|DEPLOY-MARKER|injected_/.test(e.text) &&
    (e.level === 'error' || /\[CLIENT|composite_failed|mac_unreachable|capture_failed|R2|backup/.test(e.text));
  const errs = arr.filter(isReal).slice(-n);
  if (!errs.length) return '直近の実エラーログはありません（テスト注入・統計は除外）';
  return '```' + errs.map(e => `${e.time.slice(11, 19)} ${e.text.replace(/^\[[^\]]+\]\s*/, '').slice(0, 120)}`).join('\n') + '```';
}

async function failedList() {
  const arr = await httpJson(SERVER + '/api/admin/failed');
  if (!Array.isArray(arr)) return '失敗画像の取得失敗';
  if (!arr.length) return '失敗画像はありません';
  return '*失敗画像 ' + arr.length + '件*\n' + arr.slice(0, 15).map(f => `• ${f.fileName}`).join('\n')
    + '\n（再送/DLは管理画面の「失敗画像」タブから）';
}

const HELP = [
  '*EggCamera Bot コマンド*（`/egg <sub>`）',
  '• `status` … 全体の状況確認',
  '• `restart node` … Nodeサーバ再起動',
  '• `restart mac` … EggCameraMac再起動',
  '• `restart iphone` … iPhone*アプリ*再起動（ビルドなし・速い）',
  '• `reboot iphone` … iPhone*本体*再起動（最終手段。パスコード有りだと要手動解除）',
  '• `refresh iphone` … iPhoneアプリ再ビルド＋入れ直し（プロファイル更新）',
  '• `logs` … 直近のエラーログ',
  '• `failed` … 失敗画像の一覧',
  '• `help` … この一覧',
].join('\n');

// サブコマンド振り分け
async function run(text) {
  const t = (text || '').trim().toLowerCase();
  if (t === '' || t === 'help') return HELP;
  if (t === 'status') return status();
  if (t === 'restart node') return restartNode();
  if (t === 'restart mac')  return restartMac();
  if (t === 'restart iphone') return restartIphone();
  if (t === 'reboot iphone')  return rebootIphone();
  if (t === 'refresh iphone' || t === 'refresh') return refreshIphone();
  if (t === 'logs') return logs();
  if (t === 'failed') return failedList();
  return `不明なコマンド: \`${text}\`\n${HELP}`;
}

module.exports = { run, status, restartNode, restartMac, restartIphone, rebootIphone, refreshIphone, logs, failedList, HELP };
