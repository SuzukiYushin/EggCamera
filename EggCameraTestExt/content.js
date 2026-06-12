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

  // ── 人間の「意外な行動」の注入（quirks） ─────────
  // 実運用は子供や家族が操作するため、整然としたフロー以外の操作にも耐えるかを検証する。
  // フォルト注入と重ねると検証が曖昧になるため、注入なしサイクルでのみ実行。ログは「◇」（alertではない）
  const P_QUIRK = 0.15;
  // 連打系は実運用で最もありがちなため、重複エントリで選ばれやすくしてある
  const QUIRKS = [
    'shutter-mash',   'shutter-mash',   // シャッター連打（多重撮影トリガ）
    'next-mash',      'next-mash',      // 「次へ」連打（二重遷移）
    'double-click',   'double-click',   // 保存ボタンの二度押し（二重送信）
    'impatient-tap',  'impatient-tap',  // アップロード中にせっかちに連打
    'reload-midflow',                   // フロー途中でブラウザリロード
    'idle-pause',                       // 入力画面で75秒放置（アイドル時の挙動）
    'rapid-reselect',                   // 写真を素早く選び直し連打
  ];

  // ── エラーカタログ（順番に注入される） ─────────
  // expectOverlay: お詫びオーバーレイが出るのが正しい挙動か
  // group: 同じリクエスト系統を妨害するフォルト。同時注入すると先に発火した方が後続を影にして
  //        未消費のまま残留する（→次サイクルで「注入なしでオーバーレイ」誤報）ため、
  //        1サイクルにつき同groupから1つだけ選ぶ。
  const FAULTS = [
    { id: 'session-create',   label: 'セッション作成API失敗',        kind: 'client', urlPattern: '/api/sessions$',           method: 'POST', mode: 'http500', count: 1,  expectOverlay: true },
    { id: 'capture-502',      label: '撮影API失敗(到達不能シミュレート)', kind: 'client', urlPattern: '/capture$',             method: 'POST', mode: 'http502', count: 1,  expectOverlay: true,  group: 'capture' },
    { id: 'capture-server',   label: '撮影失敗(サーバ側で注入)',      kind: 'server', target: 'capture',                                                       expectOverlay: true,  group: 'capture' },
    { id: 'frames-api',       label: 'フレーム一覧取得失敗',          kind: 'client', urlPattern: '/api/frames$',             method: 'GET',  mode: 'network', count: 1,  expectOverlay: false }, // 同梱フレームにフォールバック
    { id: 'settings-api',     label: 'クロップ設定取得失敗',          kind: 'client', urlPattern: '/api/settings$',           method: 'GET',  mode: 'network', count: 1,  expectOverlay: false }, // デフォルト値で続行
    { id: 'composite-upload', label: '合成画像アップロード失敗',      kind: 'client', urlPattern: '/composite$',              method: 'POST', mode: 'http500', count: 1,  expectOverlay: true,  group: 'composite' },
    { id: 'r2-server',        label: 'R2アップロード失敗→後追いに切替',   kind: 'server', target: 'r2',                                                          expectOverlay: false, group: 'composite' }, // 不安定時の代替経路: QRは即出る。後追いでアップロード
    { id: 'qr-server',        label: 'QR生成失敗(サーバ側)',          kind: 'server', target: 'qr',                                                            expectOverlay: true,  group: 'composite' },
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
  let firedFaultIds = new Set(); // このサイクルで実際に発火した注入のid

  /* ── ユーティリティ ─────────────────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];
  const chance = p => Math.random() < p;

  // サーバ(data/logs/)へ転送して Claude が監視できるようにする。fire-and-forget。
  function report(text, level = 'info') {
    try {
      fetch('/api/test-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, text }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* 送信失敗はテスト継続に影響させない */ }
  }

  function log(text) {
    const line = `${new Date().toLocaleTimeString('ja-JP')} ${text}`;
    console.log(`[EggTest] ${line}`);
    chrome.storage.local.get({ log: [] }, ({ log: l }) => {
      l.push(line);
      if (l.length > 400) l.splice(0, l.length - 400);
      chrome.storage.local.set({ log: l });
    });
    // ▲で始まる行＝要注意。それ以外は info としてサーバへも残す
    report(text, /^[▲△]/.test(text) ? 'alert' : 'info');
  }

  // get→set の read-modify-write が並行すると後勝ちで加算が消える（注入0のまま等）ため直列化する
  let statChain = Promise.resolve();
  function bumpStat(key, n = 1) {
    statChain = statChain.then(() => new Promise(resolve => {
      chrome.storage.local.get({ stats: {} }, ({ stats }) => {
        stats[key] = (stats[key] || 0) + n;
        chrome.storage.local.set({ stats }, () => resolve());
      });
    }));
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
    const usedGroups = new Set();
    for (let i = 0; i < n; i++) {
      const f = FAULTS[(faultIndex + i) % FAULTS.length];
      // 同groupは影になり残留するため打ち切り（打ち切った分は次回ローテーションの先頭になる）
      if (f.group && usedGroups.has(f.group)) break;
      if (f.group) usedGroups.add(f.group);
      picked.push(f);
    }
    await chrome.storage.local.set({
      faultIndex: (faultIndex + picked.length) % FAULTS.length,
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

  // 前サイクルの未発火フォルトを掃除する。残留したまま後のサイクルで発火すると
  // 「注入なしでオーバーレイ」誤報になる（クライアント側フックはリロードで消えるが、サーバ側CHAOSは残る）
  async function clearLeftoverFaults() {
    window.postMessage({ source: 'eggtest-ctl', cmd: 'clear' }, '*');
    firedFaultIds.clear();
    try {
      const st = await (await fetch('/api/admin/chaos')).json();
      if (st.capture > 0 || st.r2 > 0 || st.qr > 0) {
        await fetch('/api/admin/chaos', { method: 'DELETE' });
        log(`残留サーバフォルトを掃除 (capture:${st.capture} r2:${st.r2} qr:${st.qr})`);
      }
    } catch { /* サーバ無応答は healthCheck 側で検知される */ }
  }

  /* ── サイクル計画 ─────────────────────────── */
  async function newPlan() {
    await clearLeftoverFaults();
    const p = {
      name: rand(NAMES),
      skipName: chance(0.3),
      skipBday: chance(0.25),
      goBack: chance(0.15),
      backDone: false,
      faults: [],
      quirk: null,
      quirkDone: false,
    };
    if (injectFaults && chance(P_FAULT)) {
      p.faults = await armFaults();
    } else {
      chrome.storage.local.set({ currentFaults: [] });
      if (chance(P_QUIRK)) p.quirk = rand(QUIRKS);
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
          `, 誕生日:${plan.skipBday ? 'スキップ' : 'ランダム'}, 戻る:${plan.goBack ? 'あり' : 'なし'}` +
          `${plan.quirk ? `, 行動:${plan.quirk}` : ''})`);
      } else {
        handled.started = false; // ボタン未描画なら次のtickで再試行
      }
    },

    'nickname-screen': async () => {
      if (plan?.quirk === 'idle-pause' && !plan.quirkDone) {
        plan.quirkDone = true;
        bumpStat('quirks');
        busy = true;
        try {
          log('◇ 意外な行動: 入力画面で75秒放置（アイドル時の挙動確認）');
          await sleep(75_000);
          const s = screenOf();
          log(s === 'nickname-screen'
            ? '◇ 放置の結果: 画面はそのまま（アイドルリセットなし）'
            : `◇ 放置の結果: 画面が「${s}」へ自動遷移（アイドルリセット動作）`);
        } finally {
          busy = false;
        }
        return;
      }
      // プラン未生成（フロー途中で開始した場合など）はスキップで先へ進む
      if (!plan || plan.skipName) {
        click(document.querySelector('.btn-ghost'));
        return;
      }
      const input = document.querySelector('[data-section="nickname-screen"] input');
      if (!input) return;
      setInputValue(input, plan.name);
      if (plan?.quirk === 'next-mash' && !plan.quirkDone) {
        plan.quirkDone = true;
        bumpStat('quirks');
        log('◇ 意外な行動: 「次へ」連打 x5（二重遷移の確認）');
        busy = true;
        try {
          for (let i = 0; i < 5; i++) {
            click(document.querySelector('.btn-primary'));
            await sleep(120);
          }
        } finally {
          busy = false;
        }
        return;
      }
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

    'camera-screen': async () => {
      const btn = document.querySelector('[data-ui="shutter-btn"]');
      if (!btn || btn.disabled) return;
      if (handled.shutter) return;
      handled.shutter = true;
      if (plan?.quirk === 'shutter-mash' && !plan.quirkDone) {
        plan.quirkDone = true;
        bumpStat('quirks');
        log('◇ 意外な行動: シャッター連打 x6（多重撮影トリガの確認）');
        busy = true;
        try {
          let landed = 0;
          for (let i = 0; i < 6; i++) {
            if (!btn.disabled) { btn.click(); landed++; }
            await sleep(130);
          }
          // 1回しか着弾しない＝アプリ側のガードが効いている
          log(`◇ 連打の結果: ${landed}/6 回が有効なボタンに着弾`);
        } finally {
          busy = false;
        }
        return;
      }
      click(btn);
    },

    'photoselect-screen': async () => {
      if (plan?.quirk === 'reload-midflow' && !plan.quirkDone) {
        plan.quirkDone = true;
        bumpStat('quirks');
        log('◇ 意外な行動: フロー途中でブラウザリロード（誤操作からの復帰確認）');
        setTimeout(() => location.reload(), 300);
        return;
      }
      if (plan?.quirk === 'rapid-reselect' && !plan.quirkDone) {
        const photos = [...document.querySelectorAll('[aria-label^="写真"]')];
        if (photos.length >= 2) {
          plan.quirkDone = true;
          bumpStat('quirks');
          log('◇ 意外な行動: 写真を素早く選び直し x5');
          busy = true;
          try {
            for (let i = 0; i < 5; i++) { rand(photos).click(); await sleep(120); }
          } finally {
            busy = false;
          }
          // そのまま通常の選択ロジックへ落ちて続行
        }
      }
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
        if (plan?.quirk === 'double-click' && !plan.quirkDone) {
          plan.quirkDone = true;
          bumpStat('quirks');
          log('◇ 意外な行動: 保存ボタンを二度押し（二重送信の確認）');
          click(save);
        }
      }
    },

    'uploading-screen': async () => {
      if (plan?.quirk === 'impatient-tap' && !plan.quirkDone) {
        plan.quirkDone = true;
        bumpStat('quirks');
        log('◇ 意外な行動: アップロード中に連打（せっかちなタップの確認）');
        busy = true;
        try {
          for (let i = 0; i < 6; i++) {
            const btns = [...document.querySelectorAll('button')];
            if (btns.length) rand(btns).click(); else document.body?.click();
            await sleep(150);
          }
        } finally {
          busy = false;
        }
      }
      /* 完了 or オーバーレイを待つ */
    },

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
        // サイクル正常完了 — 期待がオーバーレイだった注入の検証。
        // 未発火の注入（セッション事前作成などのタイミングずれで踏まれなかった）は実バグではないので
        // 持ち越し扱いにし、発火したのにオーバーレイが出なかった場合だけ想定外とする
        const expected = (plan?.faults || []).filter(f => f.expectOverlay);
        const fired = expected.filter(f => firedFaultIds.has(f.id));
        const unfired = expected.filter(f => !firedFaultIds.has(f.id));
        if (fired.length) {
          bumpStat('unexpected');
          log(`▲ 想定外: 注入が発火したのにオーバーレイが出ずQRまで到達 (${fired.map(f => f.id).join(',')})`);
        }
        if (unfired.length) {
          log(`△ 注入未発火のままサイクル完了 — 次サイクル開始時に掃除 (${unfired.map(f => f.id).join(',')})`);
        }
        if (!expected.length && plan?.faults?.length) {
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
        verifyUnexpectedOverlay(); // 残留フォルト由来か照会してから判定する（fire-and-forget）
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

  // 注入なしのオーバーレイを実バグと断定する前に、サーバ側CHAOSの残留・直近発火を照会する
  async function verifyUnexpectedOverlay() {
    let residual = null;
    try {
      const st = await (await fetch('/api/admin/chaos')).json();
      if (st.capture > 0 || st.r2 > 0 || st.qr > 0) {
        residual = `armed capture:${st.capture} r2:${st.r2} qr:${st.qr}`;
      } else if ((st.recentFired || []).some(f => Date.now() - f.at < 60_000)) {
        residual = `直近発火: ${st.recentFired.map(f => f.target).join(',')}`;
      }
    } catch { /* 照会できなければ従来どおり実バグ扱い */ }
    if (residual) {
      log(`△ 注入なしでオーバーレイ表示 — 残留サーバフォルトが原因の可能性 (${residual})`);
      screenshot('residual-fault-overlay');
    } else {
      bumpStat('unexpected');
      bumpStat('errors');
      log('▲ 注入なしでオーバーレイ表示 — 実バグの可能性。ログを確認してください');
      screenshot('real-bug-overlay');
    }
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
      firedFaultIds.add(d.id);
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

  // 5分ごとに統計スナップショットをサーバへ（Claudeが合否を一目で追える）
  function reportSnapshot() {
    if (!running) return;
    chrome.storage.local.get({ stats: {} }, ({ stats: s }) => {
      const alerts = (s.unexpected || 0) + (s.costAlerts || 0) + (s.serverDown || 0) + (s.freezes || 0);
      report(`統計: サイクル${s.cycles || 0} DL成功${s.dlOk || 0}/失敗${s.dlFail || 0} ` +
        `注入${s.faultsInjected || 0} 行動${s.quirks || 0} オーバーレイ${s.overlays || 0} ` +
        `想定外${s.unexpected || 0} コスト警告${s.costAlerts || 0} ` +
        `サーバ無応答${s.serverDown || 0} 停滞${s.freezes || 0}`,
        alerts > 0 ? 'alert' : 'info');
    });
  }

  setInterval(tick, TICK_MS);
  setInterval(healthCheck, 30_000);
  setInterval(reportSnapshot, 5 * 60_000);
})();
