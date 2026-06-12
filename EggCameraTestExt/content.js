// EggCamera 長期運用テスト — UI自動操作 + フォールトインジェクション + 監視
//
// 通常サイクル:
//   スタート > 名前(ランダム/スキップ) > 生年月日(ランダム/スキップ)
//   > 撮影 > 写真選択(たまに撮りなおす) > 保存 > アップ > QRでDL検証 > 待機 > 最初へ
//
// エラー注入（定確率）:
//   FAULTS のカタログから「順番に」1つ選んでわざと起こす。
//   さらに定確率で 2つ/3つ/4つ を同時に注入する。
//   注入後はお詫びオーバーレイの表示と復帰（自動リロード→トップ）を検証する。
//
// 監視:
//   ・リトライストーム（同一サイクル内の実リクエスト数 → サーバコスト増の予兆）
//   ・Mac mini（サーバ）の無応答
//   ・ブラウザのイベントループ停滞（フリーズの予兆）

(() => {
  // fetchフック(hook.js)をページ本体のコンテキストへ注入する。
  // manifest の world:"MAIN" は古いChromeで使えないため、この方式にしている。
  const hookScript = document.createElement('script');
  hookScript.src = chrome.runtime.getURL('hook.js');
  hookScript.onload = () => hookScript.remove();
  (document.head || document.documentElement).appendChild(hookScript);

  const TICK_MS = 700;
  const STUCK_LIMIT_MS = 150_000;

  // ── エラー注入の確率（低確率） ─────────────────
  const P_FAULT = 0.08;            // このサイクルでエラーを注入する確率 (8%)
  const MULTI = [                  // 注入時の同時発生数（低確率で多重化）
    { n: 4, p: 0.03 },
    { n: 3, p: 0.07 },
    { n: 2, p: 0.15 },
  ];                               // 残り(75%)は1つ

  // ── エラーカタログ（順番に注入される） ─────────
  // expectOverlay: お詫びオーバーレイが出るのが正しい挙動か
  const FAULTS = [
    { id: 'session-create',   label: 'セッション作成API失敗',        kind: 'client', urlPattern: '/api/sessions$',           method: 'POST', mode: 'http500', count: 1,  expectOverlay: true },
    { id: 'capture-502',      label: '撮影API失敗(到達不能シミュレート)', kind: 'client', urlPattern: '/capture$',             method: 'POST', mode: 'http502', count: 1,  expectOverlay: true },
    { id: 'capture-server',   label: '撮影失敗(サーバ側で注入)',      kind: 'server', target: 'capture',                                                       expectOverlay: true },
    { id: 'frames-api',       label: 'フレーム一覧取得失敗',          kind: 'client', urlPattern: '/api/frames$',             method: 'GET',  mode: 'network', count: 1,  expectOverlay: false }, // 同梱フレームにフォールバック
    { id: 'settings-api',     label: 'クロップ設定取得失敗',          kind: 'client', urlPattern: '/api/settings$',           method: 'GET',  mode: 'network', count: 1,  expectOverlay: false }, // デフォルト値で続行
    { id: 'composite-upload', label: '合成画像アップロード失敗',      kind: 'client', urlPattern: '/composite$',              method: 'POST', mode: 'http500', count: 1,  expectOverlay: true },
    { id: 'r2-server',        label: 'R2アップロード失敗(サーバ側)',   kind: 'server', target: 'r2',                                                            expectOverlay: true },
    { id: 'qr-server',        label: 'QR生成失敗(サーバ側)',          kind: 'server', target: 'qr',                                                            expectOverlay: true },
    { id: 'session-poll',     label: 'セッションポーリング持続失敗',   kind: 'client', urlPattern: '/api/sessions/[0-9a-f]+$', method: 'GET',  mode: 'network', count: 25, expectOverlay: true },
    { id: 'js-error',         label: 'フロントJS実行時エラー',        kind: 'js',                                                                              expectOverlay: true },
  ];

  // リトライストーム検知の閾値（1サイクル内の実リクエスト数）
  const COST_LIMITS = { composite: 4, capture: 8, session: 5 };

  // アプリ側がアルファベット入力限定のため、名前は英字のみ
  const NAMES = ['Yushin', 'Sakura', 'Haruto', 'Hinata', 'Riku', 'Aoi',
    'Mio', 'Koharu', 'Sota', 'Ichika', 'Tsumugi', 'Egg'];

  let running = false;
  let injectFaults = true;
  let qrWaitMs = 60_000;
  let plan = null;
  let lastDownloadUrl = null;
  let lastScreen = '';
  let screenSince = Date.now();
  let busy = false;
  let handled = {};
  let lastTickAt = Date.now();
  let reqCounts = { composite: 0, capture: 0, session: 0 };
  let costAlerted = {};
  let serverWasDown = false;
  let memAlerted = false;
  let cycleStartedAt = 0;

  /* ── ユーティリティ ─────────────────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  const chance = p => Math.random() < p;

  function log(text) {
    const line = `${new Date().toLocaleTimeString('ja-JP')} ${text}`;
    console.log(`[EggTest] ${line}`);
    chrome.storage.local.get({ log: [] }, ({ log: l }) => {
      l.push(line);
      if (l.length > 400) l.splice(0, l.length - 400);
      chrome.storage.local.set({ log: l });
    });
  }

  function bumpStat(key, n = 1) {
    chrome.storage.local.get({ stats: {} }, ({ stats }) => {
      stats[key] = (stats[key] || 0) + n;
      chrome.storage.local.set({ stats });
    });
  }

  function screenOf() {
    return document.querySelector('[data-section]')?.getAttribute('data-section') || '';
  }

  function click(el) {
    if (!el) return false;
    el.click();
    return true;
  }

  function buttonByText(text) {
    return [...document.querySelectorAll('button')]
      .find(b => !b.disabled && b.textContent.includes(text));
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 失敗時スクリーンショット（ダウンロード/EggCameraTest/ に保存される）
  function screenshot(label) {
    chrome.runtime.sendMessage({ type: 'screenshot', label }).then(res => {
      if (res?.ok) log(`スクリーンショット保存: ${label}`);
    }).catch(() => {});
  }

  // 拡張が注入・稼働しているか一目で分かるステータスバッジ（画面左下）
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;' +
    'font:11px/1.6 monospace;padding:2px 10px;border-radius:99px;pointer-events:none;' +
    'background:rgba(0,0,0,0.55);color:#9ef01a;';
  badge.textContent = 'TEST: 待機中';
  const attachBadge = () => { if (document.body && !badge.isConnected) document.body.appendChild(badge); };
  attachBadge();

  function updateBadge(screen) {
    attachBadge();
    badge.style.color = running ? '#9ef01a' : '#ffb703';
    badge.textContent = running
      ? `TEST: 稼働中 [${screen || '-'}]`
      : 'TEST: 停止中（ポップアップから開始）';
  }

  /* ── エラー注入 ──────────────────────────── */
  function pickFaultCount() {
    const r = Math.random();
    let acc = 0;
    for (const { n, p } of MULTI) {
      acc += p;
      if (r < acc) return n;
    }
    return 1;
  }

  async function armFaults() {
    // ローテーション位置を storage に永続化（リロードを跨いで「順番に」進む）
    const { faultIndex = 0 } = await chrome.storage.local.get('faultIndex');
    const n = pickFaultCount();
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(FAULTS[(faultIndex + i) % FAULTS.length]);
    await chrome.storage.local.set({
      faultIndex: (faultIndex + n) % FAULTS.length,
      currentFaults: picked.map(f => f.id),
    });

    const clientFaults = [];
    for (const f of picked) {
      if (f.kind === 'client') {
        clientFaults.push({ id: f.id, urlPattern: f.urlPattern, method: f.method, mode: f.mode, count: f.count });
      } else if (f.kind === 'server') {
        // サーバ側注入は素の fetch（content script はフックの影響を受けない）
        try {
          await fetch('/api/admin/chaos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: f.target, count: 1 }),
          });
        } catch {
          log(`サーバ注入の指示に失敗: ${f.id}`);
        }
      } else if (f.kind === 'js') {
        window.postMessage({ source: 'eggtest-ctl', cmd: 'js-error', delayMs: 3000 + Math.random() * 15000 }, '*');
      }
    }
    if (clientFaults.length) {
      window.postMessage({ source: 'eggtest-ctl', cmd: 'arm', faults: clientFaults }, '*');
    }

    bumpStat('faultsInjected', n);
    const expect = picked.some(f => f.expectOverlay) ? 'オーバーレイ表示を期待' : 'フォールバック動作を期待';
    log(`★ エラー注入 x${n}: ${picked.map(f => f.label).join(' + ')} → ${expect}`);
    return picked;
  }

  /* ── サイクル計画 ─────────────────────────── */
  async function newPlan() {
    const p = {
      name: rand(NAMES),
      skipName: chance(0.3),
      skipBday: chance(0.25),
      goBack: chance(0.15),
      backDone: false,
      faults: [],
    };
    if (injectFaults && chance(P_FAULT)) {
      p.faults = await armFaults();
    } else {
      chrome.storage.local.set({ currentFaults: [] });
    }
    return p;
  }

  /* ── 画面ごとのハンドラ ───────────────────── */
  const handlers = {
    'start-screen': async () => {
      if (handled.started) return;
      handled.started = true;
      plan = await newPlan();
      lastDownloadUrl = null;
      reqCounts = { composite: 0, capture: 0, session: 0 };
      costAlerted = {};
      if (click(document.querySelector('.btn-cream'))) {
        bumpStat('cycles');
        cycleStartedAt = Date.now();
        log(`サイクル開始 (名前:${plan.skipName ? 'スキップ' : plan.name}` +
          `, 誕生日:${plan.skipBday ? 'スキップ' : 'ランダム'}, 戻る:${plan.goBack ? 'あり' : 'なし'})`);
      } else {
        handled.started = false; // ボタン未描画なら次のtickで再試行
      }
    },

    'nickname-screen': () => {
      // プラン未生成（フロー途中で開始した場合など）はスキップで先へ進む
      if (!plan || plan.skipName) {
        click(document.querySelector('.btn-ghost'));
        return;
      }
      const input = document.querySelector('[data-section="nickname-screen"] input');
      if (!input) return;
      setInputValue(input, plan.name);
      click(document.querySelector('.btn-primary'));
    },

    'birthday-screen': async () => {
      if (!plan || plan.skipBday) {
        click(document.querySelector('.btn-ghost'));
        return;
      }
      busy = true;
      try {
        const cols = document.querySelectorAll('[data-ui="date-picker"] .picker-scroll');
        for (const col of cols) {
          const items = [...col.children];
          if (items.length) rand(items).click();
          await sleep(450);
        }
        await sleep(450);
        click(buttonByText('次へ') || document.querySelector('.btn-primary'));
      } finally {
        busy = false;
      }
    },

    'camera-screen': () => {
      const btn = document.querySelector('[data-ui="shutter-btn"]');
      if (!btn || btn.disabled) return;
      if (!handled.shutter) {
        handled.shutter = true;
        click(btn);
      }
    },

    'photoselect-screen': () => {
      if (plan?.goBack && !plan.backDone) {
        plan.backDone = true;
        handled = {};
        log('「撮りなおす」で戻る');
        click(document.querySelector('.btn-ghost'));
        return;
      }
      const photos = [...document.querySelectorAll('[aria-label^="写真"]')];
      if (!photos.length) return;
      if (!handled.photoPicked) {
        handled.photoPicked = true;
        rand(photos).click();
        return;
      }
      const next = document.querySelector('.btn-primary:not(:disabled)');
      if (next) click(next);
    },

    'preview-screen': () => {
      const save = document.querySelector('.btn-primary:not(:disabled)');
      if (save && !handled.saved) {
        handled.saved = true;
        click(save);
      }
    },

    'uploading-screen': () => { /* 完了 or オーバーレイを待つ */ },

    'qr-screen': async () => {
      if (handled.qrDone) return;
      handled.qrDone = true;
      busy = true;
      try {
        if (lastDownloadUrl) {
          log(`DLテスト: ${lastDownloadUrl}`);
          const res = await chrome.runtime.sendMessage({ type: 'download', url: lastDownloadUrl });
          if (res?.ok) {
            bumpStat('dlOk');
            log(`DL成功 (${res.bytes} bytes)`);
          } else {
            bumpStat('dlFail');
            bumpStat('errors');
            log(`DL失敗: ${res?.error || `status ${res?.status}`}`);
          }
        } else {
          bumpStat('dlFail');
          log('downloadUrl が取得できなかった');
        }
        // サイクル正常完了 — 期待がオーバーレイだった注入の検証
        const expected = (plan?.faults || []).filter(f => f.expectOverlay);
        if (expected.length) {
          bumpStat('unexpected');
          log(`▲ 想定外: 注入したのにオーバーレイが出ずQRまで到達 (${expected.map(f => f.id).join(',')})`);
        } else if (plan?.faults?.length) {
          log(`✓ フォールバック動作OK (${plan.faults.map(f => f.id).join(',')})`);
        }
        if (cycleStartedAt) {
          log(`サイクル所要 ${Math.round((Date.now() - cycleStartedAt) / 1000)} 秒（QR待機を除く）`);
        }
        log(`QR画面で ${Math.round(qrWaitMs / 1000)} 秒待機`);
        await sleep(qrWaitMs);
        if (running && screenOf() === 'qr-screen') {
          click(document.querySelector('.btn-ghost'));
        }
      } finally {
        busy = false;
      }
    },

    'end-screen': () => {
      click(document.querySelector('.btn-cream'));
    },
  };

  /* ── オーバーレイ検知 ─────────────────────── */
  let overlaySeenAt = 0;
  function checkOverlay() {
    const overlay = document.querySelector('[data-section="error-overlay"]');
    if (!overlay) { overlaySeenAt = 0; return false; }

    if (!handled.overlay) {
      handled.overlay = true;
      overlaySeenAt = Date.now();
      bumpStat('overlays');
      const injected = plan?.faults || [];
      if (injected.length) {
        const expected = injected.some(f => f.expectOverlay);
        log(expected
          ? `✓ 想定通りオーバーレイ表示 (${injected.map(f => f.id).join(',')}) → 自動リロード待ち`
          : `▲ 想定外: フォールバックのはずがオーバーレイ表示 (${injected.map(f => f.id).join(',')})`);
        if (!expected) {
          bumpStat('unexpected');
          screenshot('unexpected-overlay');
        }
      } else {
        bumpStat('unexpected');
        bumpStat('errors');
        log('▲ 注入なしでオーバーレイ表示 — 実バグの可能性。ログを確認してください');
        screenshot('real-bug-overlay');
      }
    }
    // アプリは10秒で自動リロードする。30秒経っても残っていたら強制リロード
    if (overlaySeenAt && Date.now() - overlaySeenAt > 30_000) {
      log('▲ オーバーレイが自動リロードされない → 強制リロード');
      bumpStat('errors');
      location.reload();
    }
    return true;
  }

  /* ── 監視: コスト・サーバ・ブラウザ ─────────── */
  function onHookMessage(e) {
    const d = e.data;
    if (d?.source !== 'eggtest-hook') return;
    if (d.type === 'session-result') {
      lastDownloadUrl = d.downloadUrl;
    } else if (d.type === 'req') {
      reqCounts[d.kind] = (reqCounts[d.kind] || 0) + 1;
      const limit = COST_LIMITS[d.kind];
      if (limit && reqCounts[d.kind] > limit && !costAlerted[d.kind]) {
        costAlerted[d.kind] = true;
        bumpStat('costAlerts');
        log(`▲ リトライストーム検知: ${d.kind} が1サイクルで${reqCounts[d.kind]}回 — サーバコスト増のリスク`);
      }
    } else if (d.type === 'fault-fired') {
      log(`注入発火: ${d.id} (${d.url})`);
    }
  }

  let healthCount = 0;
  async function healthCheck() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch('/api/admin/metrics', { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const m = await res.json();
      if (serverWasDown) {
        serverWasDown = false;
        log('サーバ応答が回復');
      }
      // メモリリーク監視: 10分ごとに記録、1.2GB超で警告
      if (++healthCount % 20 === 0) {
        log(`サーバ状態: rss=${m.rssMB}MB load=${m.loadavg?.[0]} 空きメモリ=${Math.round(m.freeMemMB / 1024 * 10) / 10}GB`);
      }
      if (m.rssMB > 1200 && !memAlerted) {
        memAlerted = true;
        bumpStat('serverDown');
        log(`▲ サーバのメモリ使用が ${m.rssMB}MB — リークの可能性。フリーズ前に再起動を検討`);
      }
    } catch {
      if (!serverWasDown) {
        serverWasDown = true;
        bumpStat('serverDown');
        log('▲ サーバ(Mac mini)が5秒以内に応答しない — フリーズ/過負荷の可能性');
      }
    } finally {
      clearTimeout(t);
    }
  }

  /* ── メインループ ───────────────────────── */
  async function tick() {
    const now = Date.now();
    // イベントループ停滞（ブラウザフリーズの予兆）検知
    if (running && now - lastTickAt > TICK_MS * 6) {
      bumpStat('freezes');
      log(`▲ イベントループが ${Math.round((now - lastTickAt) / 1000)} 秒停滞 — ブラウザフリーズの予兆`);
    }
    lastTickAt = now;

    updateBadge(lastScreen);
    if (!running || busy) return;
    if (checkOverlay()) return;

    const screen = screenOf();
    if (screen !== lastScreen) {
      lastScreen = screen;
      screenSince = now;
      handled = {};
    } else if (now - screenSince > STUCK_LIMIT_MS) {
      bumpStat('errors');
      log(`「${screen}」で${Math.round(STUCK_LIMIT_MS / 1000)}秒停滞 → リロード`);
      screenshot(`stuck-${screen}`);
      screenSince = now;
      setTimeout(() => location.reload(), 1500); // スクショ保存を待ってからリロード
      return;
    }

    const handler = handlers[screen];
    if (handler) await handler();
  }

  window.addEventListener('message', onHookMessage);

  /* ── 起動/停止（popup から storage 経由で制御） ── */
  chrome.storage.local.get(
    { running: false, qrWaitSec: 60, injectFaults: true, currentFaults: [] },
    v => {
      running = v.running;
      qrWaitMs = v.qrWaitSec * 1000;
      injectFaults = v.injectFaults;
      if (v.currentFaults?.length) {
        log(`リロードから復帰（直前の注入: ${v.currentFaults.join(',')}）`);
        chrome.storage.local.set({ currentFaults: [] });
      }
      if (running) log('テスト再開（ページ読み込み）');
    });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.running) {
      running = changes.running.newValue;
      log(running ? 'テスト開始' : 'テスト停止');
    }
    if (changes.qrWaitSec) qrWaitMs = changes.qrWaitSec.newValue * 1000;
    if (changes.injectFaults) {
      injectFaults = changes.injectFaults.newValue;
      log(`エラー注入: ${injectFaults ? 'ON' : 'OFF'}`);
    }
  });

  setInterval(tick, TICK_MS);
  setInterval(healthCheck, 30_000);
})();
