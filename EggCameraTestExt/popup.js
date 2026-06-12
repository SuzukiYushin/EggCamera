const $ = id => document.getElementById(id);

function render() {
  chrome.storage.local.get(
    { running: false, qrWaitSec: 60, injectFaults: true, stats: {}, log: [] },
    v => {
      $('toggle').textContent = v.running ? '停止' : '開始';
      $('toggle').className = v.running ? 'stop' : 'start';
      if (document.activeElement !== $('qrwait')) $('qrwait').value = v.qrWaitSec;
      $('inject').checked = v.injectFaults;
      $('s-cycles').textContent     = v.stats.cycles || 0;
      $('s-dlok').textContent       = v.stats.dlOk || 0;
      $('s-dlfail').textContent     = v.stats.dlFail || 0;
      $('s-faults').textContent     = v.stats.faultsInjected || 0;
      $('s-overlays').textContent   = v.stats.overlays || 0;
      $('s-unexpected').textContent = v.stats.unexpected || 0;
      $('s-cost').textContent       = v.stats.costAlerts || 0;
      $('s-down').textContent       = v.stats.serverDown || 0;
      $('s-freeze').textContent     = v.stats.freezes || 0;
      const logEl = $('log');
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
      logEl.textContent = v.log.slice(-150).join('\n');
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    });
}

$('toggle').addEventListener('click', () => {
  chrome.storage.local.get({ running: false }, v => {
    chrome.storage.local.set({ running: !v.running });
  });
});

$('clear').addEventListener('click', () => {
  chrome.storage.local.set({ stats: {}, log: [], faultIndex: 0, currentFaults: [] });
});

// テストレポート（統計＋全ログ）をテキストファイルで保存
$('export').addEventListener('click', () => {
  chrome.storage.local.get({ stats: {}, log: [] }, v => {
    const lines = [
      `EggCamera 長期運用テスト レポート ${new Date().toLocaleString('ja-JP')}`,
      '',
      `サイクル: ${v.stats.cycles || 0} / DL成功: ${v.stats.dlOk || 0} / DL失敗: ${v.stats.dlFail || 0}`,
      `注入: ${v.stats.faultsInjected || 0} / オーバーレイ: ${v.stats.overlays || 0} / 想定外: ${v.stats.unexpected || 0}`,
      `コスト警告: ${v.stats.costAlerts || 0} / サーバ無応答: ${v.stats.serverDown || 0} / 停滞検知: ${v.stats.freezes || 0} / その他エラー: ${v.stats.errors || 0}`,
      '',
      '──── ログ ────',
      ...v.log,
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chrome.downloads.download({ url, filename: `EggCameraTest/report_${stamp}.txt` });
  });
});

$('qrwait').addEventListener('change', () => {
  const sec = Math.max(5, Math.min(600, parseInt($('qrwait').value, 10) || 60));
  chrome.storage.local.set({ qrWaitSec: sec });
});

$('inject').addEventListener('change', () => {
  chrome.storage.local.set({ injectFaults: $('inject').checked });
});

render();
setInterval(render, 1000);
