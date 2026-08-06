// 管理画面のスクリーンショット撮影（手順書 data/admin-pages/*.png の作り直し用）。
//
// なぜCDPなのか:
//   Chrome の --screenshot は「保存後もプロセスが終了せず CVDisplayLink エラーを出し続ける」ため
//   コマンドが返らない。加えて管理画面はサブリソース(admin.js/css)にも認証が要るので、
//   URLの ?token= だけでは 401 になり真っ白なページが撮れてしまう。
//   → CDP で Network.setExtraHTTPHeaders に X-Admin-Token を入れて全リクエストを通す。
//
// 使い方:
//   1) Chrome をデバッグポート付きで起動（背景）
//      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
//        --no-first-run --hide-scrollbars --user-data-dir=/tmp/adminshot \
//        --remote-debugging-port=9222 about:blank &
//   2) 撮影（既存の手順書画像は 1280x1000・deviceScaleFactor=2 = 2560x2000）
//      node admin-shot.mjs <出力.png> /admin/ <ADMIN_TOKEN> 1280 1000 '[{"js":"…","wait":800}]'
//   3) 後始末: pkill -9 -f adminshot
//
// steps は「撮影前に実行するJS」の配列。タブ切替・スクロール・ライブビュー開始などに使う。
//   例) 写真設定タブでライブビューを出す:
//     [{"js":"document.querySelector('[data-tab=photo]').click(); 'tab'","wait":900},
//      {"js":"document.querySelector('#btn-liveview').click(); 'start'","wait":6000}]
//   ※ ライブビューはカメラを使う。接客中は避け、撮影後は必ず Chrome を落として切断すること。
const [out, urlPath, token, w = 1280, h = 1000, stepsJson = '[]'] = process.argv.slice(2);
const steps = JSON.parse(stepsJson);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('page target なし'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send('Network.enable');
await send('Network.setExtraHTTPHeaders', { headers: { 'X-Admin-Token': token } });
await send('Emulation.setDeviceMetricsOverride',
  { width: +w, height: +h, deviceScaleFactor: 2, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:3001${urlPath}` });
await sleep(3500);

for (const [i, s] of steps.entries()) {
  const r = await send('Runtime.evaluate', { expression: s.js, returnByValue: true, awaitPromise: true });
  console.error(`  step${i + 1}: ${JSON.stringify(r.result.value)}`);
  await sleep(s.wait ?? 800);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.data, 'base64'));
ws.close();
console.error(`  saved: ${out}`);
