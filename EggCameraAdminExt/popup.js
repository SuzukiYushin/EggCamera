const $ = id => document.getElementById(id);

function render() {
  chrome.storage.local.get({
    adminRunning: false,
    adminIntervalMin: 10,
    adminLastResult: null,
    adminLastResultAt: null,
    adminLastHasError: false,
    adminLog: [],
  }, v => {
    $('toggle').textContent = v.adminRunning ? '停止' : '開始';
    $('toggle').className   = v.adminRunning ? 'stop' : 'start';
    $('status').textContent  = v.adminRunning ? '稼働中' : '停止中';
    $('status').className    = `status ${v.adminRunning ? 'running' : 'stopped'}`;

    if (document.activeElement !== $('interval')) $('interval').value = v.adminIntervalMin;

    const resultEl = $('result');
    if (v.adminLastResult) {
      const t = v.adminLastResultAt ? new Date(v.adminLastResultAt).toLocaleTimeString('ja-JP') : '';
      resultEl.textContent  = `[${t}] ${v.adminLastResult}`;
      resultEl.className    = `result ${v.adminLastHasError ? 'error' : 'ok'}`;
    }

    const logEl = $('log');
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
    logEl.textContent = v.adminLog.slice(-100).join('\n');
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  });
}

$('toggle').addEventListener('click', () => {
  chrome.storage.local.get({ adminRunning: false }, v => {
    chrome.storage.local.set({ adminRunning: !v.adminRunning });
  });
});

$('interval').addEventListener('change', () => {
  const min = Math.max(1, Math.min(60, parseInt($('interval').value, 10) || 10));
  chrome.storage.local.set({ adminIntervalMin: min });
});

render();
setInterval(render, 1000);
