// EggCamera 管理画面テスト用コンテンツスクリプト
//
// 動作:
//   1. popup で「開始」→ 即時1サイクル実行、以降は設定間隔ごとに繰り返す
//   2. サイクル開始時に localStorage['eggcamera-admin-busy'] をセット
//      → 同一オリジンの別タブで動くメインテスト拡張がこれを検知して一時停止する
//   3. 管理 API を順に呼んで動作確認（フレーム/設定/失敗一覧/ディスク）
//   4. サイクル終了後に localStorage フラグをクリア → メインテスト再開

(() => {
  // 管理画面ページ以外では何もしない
  if (!location.pathname.startsWith('/admin')) return;

  const BUSY_KEY = 'eggcamera-admin-busy';

  // 管理 API 呼び出し（adminToken は管理ページが localStorage に保存済み）
  const adminFetch = async (path, init = {}) => {
    const tok = localStorage.getItem('adminToken') || '';
    if (tok) init = { ...init, headers: { ...(init.headers || {}), 'X-Admin-Token': tok } };
    const r = await fetch(`/api/admin${path}`, init);
    if (!r.ok) throw new Error(`http_${r.status}`);
    return r.json();
  };

  // サーバログへ転送（check-soak.js が読むログファイルに記録される）
  const serverLog = (text, level = 'info') => {
    fetch('/api/test-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, text: `[ADMIN-TEST] ${text}` }),
      keepalive: true,
    }).catch(() => {});
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const localLog = msg => {
    chrome.storage.local.get({ adminLog: [] }, ({ adminLog }) => {
      const ts = new Date().toLocaleTimeString('ja-JP');
      adminLog = [...adminLog.slice(-150), `[${ts}] ${msg}`];
      chrome.storage.local.set({ adminLog, adminLastMsg: msg, adminLastAt: Date.now() });
    });
  };

  let running = false;
  let cycleTimer = null;

  const setAdminBusy = busy => {
    if (busy) {
      localStorage.setItem(BUSY_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(BUSY_KEY);
    }
  };

  const runCycle = async () => {
    if (!running) return;

    // ── 1. メインテスト一時停止 ──
    setAdminBusy(true);
    localLog('管理操作サイクル開始 — メインテスト一時停止');
    serverLog('管理操作サイクル開始（メインテスト一時停止）');
    await sleep(1500); // メインテストの tick が停止するのを待つ

    const results = [];

    // ── 2. フレーム切り替えテスト ──
    try {
      const frames = await adminFetch('/frames');
      if (frames.length > 0) {
        const target = frames[0];
        const toggled = !target.active;
        await adminFetch(`/frames/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: toggled }),
        });
        await sleep(400);
        // 元の状態に戻す
        await adminFetch(`/frames/${target.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: target.active }),
        });
        results.push(`フレーム操作OK(${frames.length}件)`);
      } else {
        results.push('フレーム0件(スキップ)');
      }
    } catch (e) {
      results.push(`フレーム操作NG: ${e.message}`);
    }

    // ── 3. 設定取得確認 ──
    try {
      await adminFetch('/settings');
      results.push('設定API OK');
    } catch (e) {
      results.push(`設定API NG: ${e.message}`);
    }

    // ── 4. 失敗アップロード確認（あればリトライ） ──
    try {
      const failed = await adminFetch('/failed');
      if (failed.length > 0) {
        try {
          await adminFetch(`/failed/${encodeURIComponent(failed[0].fileName)}/retry`, { method: 'POST' });
          results.push(`失敗アップロードリトライOK(${failed.length}件)`);
        } catch (e) {
          results.push(`失敗アップロードリトライNG: ${e.message}`);
        }
      } else {
        results.push('失敗アップロード0件');
      }
    } catch (e) {
      results.push(`失敗一覧NG: ${e.message}`);
    }

    // ── 5. ディスク容量確認 ──
    try {
      const disk = await adminFetch('/disk');
      const gb = n => (n / 1024 / 1024 / 1024).toFixed(1);
      results.push(`ディスク空き${gb(disk.freeBytes)}GB`);
    } catch (e) {
      results.push(`ディスクNG: ${e.message}`);
    }

    // ── 6. 結果報告 ──
    const summary = results.join(' / ');
    const hasError = results.some(r => r.includes('NG'));
    localLog(`管理操作完了: ${summary}`);
    serverLog(`管理操作完了: ${summary}`, hasError ? 'alert' : 'info');
    chrome.storage.local.set({ adminLastResult: summary, adminLastResultAt: Date.now(), adminLastHasError: hasError });

    // ── 7. メインテスト再開 ──
    setAdminBusy(false);
    localLog('メインテスト再開');
    serverLog('管理操作完了（メインテスト再開）');
  };

  const scheduleNext = () => {
    chrome.storage.local.get({ adminIntervalMin: 10 }, ({ adminIntervalMin }) => {
      cycleTimer = setTimeout(async () => {
        if (!running) return;
        await runCycle();
        scheduleNext();
      }, adminIntervalMin * 60_000);
    });
  };

  // popup → chrome.storage.local 経由で制御
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.adminRunning) return;
    running = changes.adminRunning.newValue;
    if (running) {
      localLog('管理テスト開始');
      runCycle().then(scheduleNext);
    } else {
      localLog('管理テスト停止');
      clearTimeout(cycleTimer);
      setAdminBusy(false); // 停止時は必ずフラグ解除
    }
  });

  // ページロード時に running 状態を復元
  chrome.storage.local.get({ adminRunning: false }, ({ adminRunning }) => {
    running = adminRunning;
    if (running) {
      localLog('管理テスト再開（ページ読み込み）');
      runCycle().then(scheduleNext);
    }
  });
})();
