// MAINワールドのフック:
// 1. fetch を監視して downloadUrl を content script へ渡す
// 2. content script からの指示で特定リクエストをわざと失敗させる（フォールト注入）
// 3. 実際に外へ出たリクエスト数をカウントして報告（リトライストーム＝コスト増の監視）
// 4. 指示があれば JS 実行時エラーをわざと投げる
(() => {
  const origFetch = window.fetch;

  // 注入中のフォールト: {id, urlPattern(RegExp), method, mode, count}
  let faults = [];

  window.addEventListener('message', e => {
    const d = e.data;
    if (d?.source !== 'eggtest-ctl') return;
    if (d.cmd === 'arm') {
      faults = (d.faults || []).map(f => ({ ...f, urlPattern: new RegExp(f.urlPattern) }));
    } else if (d.cmd === 'clear') {
      faults = [];
    } else if (d.cmd === 'js-error') {
      setTimeout(() => { throw new Error('injected_js_error (長期運用テスト)'); }, d.delayMs || 0);
    }
  });

  function matchFault(url, method) {
    for (const f of faults) {
      if (f.count <= 0) continue;
      if (!f.urlPattern.test(url)) continue;
      if (f.method && f.method !== method) continue;
      f.count--;
      return f;
    }
    return null;
  }

  function reportRequest(url, method) {
    let kind = null;
    if (/\/composite$/.test(url) && method === 'POST') kind = 'composite';
    else if (/\/capture$/.test(url) && method === 'POST') kind = 'capture';
    else if (/\/api\/sessions$/.test(url) && method === 'POST') kind = 'session';
    if (kind) window.postMessage({ source: 'eggtest-hook', type: 'req', kind }, '*');
  }

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = (args[1]?.method || (typeof args[0] === 'object' && args[0]?.method) || 'GET').toUpperCase();

    const fault = matchFault(url, method);
    if (fault) {
      window.postMessage({ source: 'eggtest-hook', type: 'fault-fired', id: fault.id, url }, '*');
      if (fault.mode === 'network') {
        throw new TypeError('Failed to fetch (injected)');
      }
      // http500 / http502 など
      const status = fault.mode === 'http502' ? 502 : 500;
      return new Response(JSON.stringify({ error: 'injected_fault' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    reportRequest(url, method);
    const res = await origFetch.apply(this, args);

    try {
      if (/\/api\/sessions\/[0-9a-f]+$/.test(url) && method === 'GET') {
        const clone = res.clone();
        clone.json().then(session => {
          if (session?.result?.downloadUrl) {
            window.postMessage({
              source: 'eggtest-hook',
              type: 'session-result',
              downloadUrl: session.result.downloadUrl,
              sessionId: session.id,
            }, '*');
          }
        }).catch(() => {});
      }
    } catch { /* フックの失敗はアプリ動作に影響させない */ }
    return res;
  };
})();
