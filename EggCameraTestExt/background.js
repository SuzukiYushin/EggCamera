// QRのダウンロードURLを実際に取得して、DLが成功するか検証する。
// downloadUrl はダウンロードページ（/download?id=xxx）なので、
// 画像本体（/image/xxx.jpg）も導出して試す。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 失敗時スクリーンショット: 表示中タブを撮って ダウンロード/EggCameraTest/ に保存
  if (msg.type === 'screenshot') {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' }, dataUrl => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message });
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      chrome.downloads.download({
        url: dataUrl,
        filename: `EggCameraTest/error_${stamp}_${msg.label || 'unknown'}.png`,
      }, id => sendResponse({ ok: !!id }));
    });
    return true;
  }

  if (msg.type !== 'download') return;

  (async () => {
    const candidates = [];
    try {
      const u = new URL(msg.url);
      const id = u.searchParams.get('id');
      if (id) candidates.push(`${u.origin}/image/${id}.jpg`);
    } catch { /* URLパース失敗時はページURLのみ */ }
    candidates.push(msg.url);

    let last = { ok: false, error: 'no_candidates' };
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        last = { ok: res.ok, status: res.status, bytes: buf.byteLength, url };
        if (res.ok && buf.byteLength > 10_000) break; // 画像本体が取れたら終了
      } catch (err) {
        last = { ok: false, error: String(err), url };
      }
    }
    sendResponse(last);
  })();

  return true; // 非同期レスポンス
});
