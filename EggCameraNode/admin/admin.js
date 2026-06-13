/* Photo Booth 管理画面 */
const $ = sel => document.querySelector(sel);

// 管理APIにトークンが要る場合: ?token=… を一度開くと localStorage に保存し、
// 以降は自動付与する。トークン無効なら従来どおり素通り。
const ADMIN_TOKEN = (() => {
  const p = new URLSearchParams(location.search).get('token');
  if (p) localStorage.setItem('adminToken', p);
  return localStorage.getItem('adminToken') || '';
})();
// img/aタグ用にトークンをクエリで付ける
function withToken(url) {
  if (!ADMIN_TOKEN) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(ADMIN_TOKEN);
}

const api = {
  async get(path)        { return req(path); },
  async del(path)        { return req(path, { method: 'DELETE' }); },
  async patch(path, b)   { return req(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
  async post(path, b)    { return req(path, { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
  async put(path, b)     { return req(path, { method: 'PUT',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
};
async function req(path, init = {}) {
  if (ADMIN_TOKEN) init.headers = { ...(init.headers || {}), 'X-Admin-Token': ADMIN_TOKEN };
  const res = await fetch(`/api/admin${path}`, init);
  if (res.status === 401) throw new Error('unauthorized（?token=… を付けて開いてください）');
  if (!res.ok) {
    let code = `http_${res.status}`;
    try { const j = await res.json(); if (j.error) code = j.error; } catch {}
    throw new Error(code);
  }
  return res.json();
}

/* ── タブ切り替え ──────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    for (const id of ['frames', 'photo', 'failed', 'logs']) {
      $(`#tab-${id}`).hidden = btn.dataset.tab !== id;
    }
    if (btn.dataset.tab === 'logs') startLogPolling(); else stopLogPolling();
    if (btn.dataset.tab === 'failed') loadFailed();
    if (btn.dataset.tab === 'restart') loadRestart();
  });
});

/* ── フレーム管理 ──────────────────────── */
async function loadFrames() {
  const frames = await api.get('/frames');
  const grid = $('#frame-grid');
  grid.innerHTML = '';
  for (const f of frames) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" src="${f.url}" alt="">
      <div class="name"></div>
      <button class="badge ${f.active ? 'active' : 'hidden-badge'}">${f.active ? '使用中' : '非表示'}</button>
      <button class="del" title="削除">x</button>`;
    card.querySelector('.name').textContent = f.name;
    card.querySelector('.badge').addEventListener('click', async () => {
      await api.patch(`/frames/${f.id}`, { active: !f.active });
      loadFrames();
    });
    card.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`「${f.name}」を一覧から削除しますか？\n（ファイルは Mac mini 内に残ります）`)) return;
      await api.del(`/frames/${f.id}`);
      loadFrames();
    });
    grid.appendChild(card);
  }
}

async function loadDisk() {
  try {
    const d = await api.get('/disk');
    const gb = n => (n / 1024 / 1024 / 1024).toFixed(1);
    $('#disk').textContent = `HDD 空き容量: ${gb(d.freeBytes)} GB / ${gb(d.totalBytes)} GB`;
  } catch {
    $('#disk').textContent = 'HDD 空き容量: 取得失敗';
  }
}

/* ── フレーム追加モーダル ────────────────── */
let browseDir = null;
let selectedServerPath = null;

$('#btn-add').addEventListener('click', () => {
  $('#modal').hidden = false;
  $('#add-name').value = '';
  $('#add-file').value = '';
  $('#add-status').textContent = '';
  selectedServerPath = null;
  $('#browse-selected').textContent = '';
  browse(null);
});
$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) $('#modal').hidden = true; });

document.querySelectorAll('.src-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.src-tab').forEach(b => b.classList.toggle('active', b === btn));
    $('#src-pc').hidden = btn.dataset.src !== 'pc';
    $('#src-server').hidden = btn.dataset.src !== 'server';
  });
});

async function browse(dir) {
  const q = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  const data = await api.get(`/browse${q}`);
  browseDir = data.dir;
  $('#browse-path').textContent = data.dir;
  const ul = $('#browse-list');
  ul.innerHTML = '';
  if (data.parent) {
    const li = document.createElement('li');
    li.className = 'dir';
    li.textContent = '.. （上へ）';
    li.addEventListener('click', () => browse(data.parent));
    ul.appendChild(li);
  }
  for (const d of data.dirs) {
    const li = document.createElement('li');
    li.className = 'dir';
    li.textContent = d;
    li.addEventListener('click', () => browse(`${data.dir}/${d}`));
    ul.appendChild(li);
  }
  for (const f of data.files) {
    const li = document.createElement('li');
    li.className = 'file';
    li.textContent = f;
    li.addEventListener('click', () => {
      selectedServerPath = `${browseDir}/${f}`;
      ul.querySelectorAll('li').forEach(x => x.classList.remove('selected'));
      li.classList.add('selected');
      $('#browse-selected').textContent = `選択中: ${selectedServerPath}`;
    });
    ul.appendChild(li);
  }
}

$('#btn-upload').addEventListener('click', async () => {
  const name = $('#add-name').value.trim();
  const status = $('#add-status');
  const fromPC = !$('#src-pc').hidden;
  status.className = 'status';
  try {
    if (fromPC) {
      const file = $('#add-file').files[0];
      if (!file) throw new Error('ファイルを選択してください');
      status.textContent = 'アップロード中…';
      const res = await fetch('/api/admin/frames', {
        method: 'POST',
        headers: {
          'Content-Type': file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
          'X-Frame-Name': encodeURIComponent(name || file.name.replace(/\.[^.]+$/, '')),
          ...(ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {}),
        },
        body: file,
      });
      if (!res.ok) throw new Error('アップロードに失敗しました');
    } else {
      if (!selectedServerPath) throw new Error('Mac mini 内のファイルを選択してください');
      status.textContent = '追加中…';
      await api.post('/frames/from-server', { path: selectedServerPath, name });
    }
    status.textContent = '追加しました';
    await loadFrames();
    setTimeout(() => { $('#modal').hidden = true; }, 500);
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  }
});

/* ── 写真設定（テスト撮影＋クロップ調整） ────── */
let testImage = null;
let savedCrop = { zoom: 1, offsetX: 0, offsetY: 0 };

async function loadSettings() {
  try {
    const s = await api.get('/settings');
    savedCrop = s.crop;
    $('#crop-zoom').value = s.crop.zoom;
    $('#crop-ox').value = s.crop.offsetX;
    $('#crop-oy').value = s.crop.offsetY;
  } catch {}
}

function currentCrop() {
  return {
    zoom:    parseFloat($('#crop-zoom').value) || 1,
    offsetX: parseFloat($('#crop-ox').value) || 0,
    offsetY: parseFloat($('#crop-oy').value) || 0,
  };
}

/* FinalPreview と同じクロップ計算（2:3 cover → zoom/offset 適用） */
function drawCropPreview() {
  if (!testImage) return;
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const { zoom, offsetX, offsetY } = currentCrop();

  const targetAspect = 2 / 3;
  const iw = testImage.naturalWidth, ih = testImage.naturalHeight;
  let cw, ch;
  if (iw / ih > targetAspect) { ch = ih; cw = ch * targetAspect; }
  else { cw = iw; ch = cw / targetAspect; }

  let rw = cw / zoom, rh = ch / zoom;
  let rx = (iw - cw) / 2 + (cw - rw) / 2 + (offsetX / 100) * rw;
  let ry = (ih - ch) / 2 + (ch - rh) / 2 + (offsetY / 100) * rh;
  rx = Math.max(0, Math.min(rx, iw - rw));
  ry = Math.max(0, Math.min(ry, ih - rh));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(testImage, rx, ry, rw, rh, 0, 0, canvas.width, canvas.height);
}

['crop-zoom', 'crop-ox', 'crop-oy'].forEach(id => {
  $(`#${id}`).addEventListener('input', () => {
    drawCropPreview();
    // 値を変えたら古い「保存しました」を消して未保存を明示
    const status = $('#crop-status');
    status.className = 'status';
    status.textContent = '未保存の変更があります';
  });
});

$('#btn-test-capture').addEventListener('click', async () => {
  const btn = $('#btn-test-capture');
  const status = $('#crop-status');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = '撮影中…（最大25秒）';
  try {
    const { url } = await api.post('/test-capture', {});
    const img = new Image();
    img.onload = () => {
      testImage = img;
      $('#crop-placeholder').hidden = true;
      drawCropPreview();
      status.textContent = '撮影完了';
    };
    img.onerror = () => { status.className = 'status err'; status.textContent = '画像の読み込みに失敗'; };
    img.src = url;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `撮影失敗: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('#btn-save-crop').addEventListener('click', async () => {
  const status = $('#crop-status');
  try {
    const saved = await api.put('/settings', { crop: currentCrop() });
    savedCrop = saved.crop;
    status.className = 'status';
    const t = new Date().toLocaleTimeString('ja-JP');
    status.textContent = `保存しました ${t}（次の撮影から反映）`;
  } catch (err) {
    status.className = 'status err';
    status.textContent = `保存失敗: ${err.message}`;
  }
});

/* ── ログ ─────────────────────────────── */
let logTimer = null;
let lastSeq = 0;

async function pollLogs() {
  try {
    const lines = await api.get(`/logs?since=${lastSeq}`);
    if (lines.length) {
      const view = $('#log-view');
      for (const l of lines) {
        lastSeq = l.seq;
        const span = document.createElement('span');
        span.className = l.level;
        span.textContent = `${l.time} [${l.level}] ${l.text}\n`;
        view.appendChild(span);
      }
      while (view.childNodes.length > 2000) view.removeChild(view.firstChild);
      if ($('#log-autoscroll').checked) view.scrollTop = view.scrollHeight;
    }
  } catch {}
}
function startLogPolling() {
  if (logTimer) return;
  pollLogs();
  logTimer = setInterval(pollLogs, 2000);
}
function stopLogPolling() {
  clearInterval(logTimer);
  logTimer = null;
}

/* ── 失敗画像 ─────────────────────────── */
async function loadFailed() {
  const items = await api.get('/failed').catch(() => []);
  const grid = $('#failed-grid');
  grid.innerHTML = '';
  $('#failed-empty').style.display = items.length ? 'none' : '';
  for (const it of items) {
    const when = new Date(it.failedAt).toLocaleString('ja-JP');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img class="thumb" src="${withToken(it.url)}" alt="" style="aspect-ratio:2/3;object-fit:cover;">
      <div class="name"></div>
      <div class="failed-when"></div>
      <div class="failed-actions">
        <a class="badge active" download>ダウンロード</a>
        <button class="badge" data-act="retry">再送</button>
        <button class="del" title="一覧から削除">x</button>
      </div>`;
    card.querySelector('.name').textContent = it.fileName;
    card.querySelector('.failed-when').textContent = `失敗: ${when}`;
    const dl = card.querySelector('a.badge');
    dl.href = withToken(`${it.url}?download=1`);
    card.querySelector('[data-act="retry"]').addEventListener('click', async (e) => {
      const b = e.target; b.disabled = true; b.textContent = '再送中…';
      try {
        await api.post(`/failed/${encodeURIComponent(it.fileName)}/retry`, {});
        loadFailed(); refreshFailedCount();
      } catch { b.disabled = false; b.textContent = '再送失敗'; }
    });
    card.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`「${it.fileName}」を一覧から削除しますか？（ローカルの失敗画像も消えます）`)) return;
      await api.del(`/failed/${encodeURIComponent(it.fileName)}`);
      loadFailed(); refreshFailedCount();
    });
    grid.appendChild(card);
  }
}

// タブのバッジに失敗件数を出す（定期更新）
async function refreshFailedCount() {
  const items = await api.get('/failed').catch(() => []);
  const badge = $('#failed-count');
  if (items.length) { badge.textContent = items.length; badge.hidden = false; }
  else badge.hidden = true;
}

/* ── 再起動タブ ─────────────────────────── */
const RESTART_LABELS = {
  iphone: 'iPhoneアプリ再起動', mac: 'EggCameraMac再起動', node: 'Nodeサーバ再起動',
  'iphone-refresh': 'iPhoneアプリ再ビルド(refresh)', 'iphone-reboot': 'iPhone本体再起動', 'mac-reboot': 'Mac mini本体再起動',
};
const RESTART_DESC = {
  iphone: 'アプリだけ再起動・数秒・最も軽い', mac: '撮影トリガ役のMacアプリを再起動',
  node: 'APIサーバを再起動', 'iphone-refresh': 'プロファイル更新つき再ビルド',
  'iphone-reboot': 'iPhoneのiOSごと再起動（最終手段）', 'mac-reboot': 'Mac mini本体を再起動（最終手段）',
};
const RESTART_ORDER_ALL = ['iphone', 'mac', 'node', 'iphone-refresh', 'iphone-reboot', 'mac-reboot'];
let lastDiagSig = '';
let diagDismissed = '';

async function loadRestart() {
  const diag = await api.get('/diagnose').catch(() => null);
  renderRestartButtons(diag);
  renderDiagBox(diag);
  maybePopupDiag(diag);
}

function renderRestartButtons(diag) {
  const grid = $('#restart-grid');
  grid.innerHTML = '';
  const primary = diag && diag.primary;
  const ordered = (diag && diag.ordered) || [];
  for (const id of RESTART_ORDER_ALL) {
    const rank = ordered.indexOf(id);
    const card = document.createElement('div');
    card.className = 'restart-card' + (primary === id ? ' recommend' : '');
    card.innerHTML = `
      <div class="rc-name"></div>
      <div class="rc-desc"></div>
      <div class="rc-rank"></div>
      <button class="btn-pink rc-btn">再起動</button>`;
    card.querySelector('.rc-name').textContent = RESTART_LABELS[id];
    card.querySelector('.rc-desc').textContent = RESTART_DESC[id];
    card.querySelector('.rc-rank').textContent =
      primary === id ? '★ まずこれを推奨' : (rank >= 0 ? `推奨順 ${rank + 1}番目` : '');
    if (/reboot/.test(id)) card.querySelector('.rc-btn').style.background = '#FF5A5A';
    card.querySelector('.rc-btn').addEventListener('click', () => askPassword(id));
    grid.appendChild(card);
  }
}

function renderDiagBox(diag) {
  const box = $('#diag-box');
  if (!diag) { box.textContent = ''; return; }
  if (!diag.hasError) {
    box.className = 'diag-box ok';
    box.textContent = '✅ ' + diag.reason;
  } else {
    box.className = 'diag-box err';
    box.innerHTML = `⚠️ <b>${diag.reason}</b>`;
  }
}

// エラー検知時、未対応の新しい内容ならポップアップ
function maybePopupDiag(diag) {
  const badge = $('#restart-badge');
  if (diag && diag.hasError) { badge.hidden = false; } else { badge.hidden = true; }
  if (!diag || !diag.hasError) return;
  if (diag.signature === diagDismissed) return; // 無視済みの同じエラー
  if (diag.signature === lastDiagSig && $('#diag-modal').hidden === false) return;
  lastDiagSig = diag.signature;
  $('#diag-reason').textContent = diag.reason;
  const order = $('#diag-order');
  order.innerHTML = '<b>推奨順:</b> ' + diag.ordered.map((id, i) =>
    `${i + 1}. ${RESTART_LABELS[id] || id}`).join(' → ');
  $('#diag-recent').textContent = (diag.recent || []).map(r => `${r.time} ${r.text}`).join('\n');
  $('#diag-modal').hidden = false;
}

$('#diag-close').addEventListener('click', () => { $('#diag-modal').hidden = true; });
$('#diag-ignore').addEventListener('click', () => { diagDismissed = lastDiagSig; $('#diag-modal').hidden = true; });
$('#diag-goto').addEventListener('click', () => {
  $('#diag-modal').hidden = true;
  document.querySelector('.tab[data-tab="restart"]').click();
  $('#restart-grid').scrollIntoView({ behavior: 'smooth' });
});

// パスワード確認 → 実行
let pendingTarget = null;
function askPassword(target) {
  pendingTarget = target;
  $('#pw-title').textContent = RESTART_LABELS[target] + ' の確認';
  $('#pw-target').textContent = `「${RESTART_LABELS[target]}」を実行します。${/reboot/.test(target) ? '本体ごと再起動するため数分かかります。' : ''}`;
  $('#pw-input').value = '';
  $('#pw-status').textContent = '';
  $('#pw-status').className = 'status';
  $('#pw-modal').hidden = false;
  setTimeout(() => $('#pw-input').focus(), 100);
}
$('#pw-close').addEventListener('click', () => { $('#pw-modal').hidden = true; });
$('#pw-exec').addEventListener('click', execRestart);
$('#pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') execRestart(); });

async function execRestart() {
  const pw = $('#pw-input').value;
  const status = $('#pw-status');
  status.className = 'status';
  status.textContent = '実行中…';
  try {
    const res = await fetch(`/api/admin/restart/${pendingTarget}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {}) },
      body: JSON.stringify({ password: pw }),
    });
    if (res.status === 401) { status.className = 'status err'; status.textContent = 'パスワードが違います'; return; }
    const j = await res.json();
    status.textContent = j.message || '実行しました';
    diagDismissed = lastDiagSig; // 対応したので同じエラーは再ポップアップしない
    setTimeout(() => { $('#pw-modal').hidden = true; loadRestart(); }, 2500);
  } catch (err) {
    status.className = 'status err';
    status.textContent = '失敗: ' + err.message;
  }
}

$('#restart-resume').addEventListener('click', async () => {
  await api.post('/maintenance/stop', {}).catch(() => {});
  alert('通常運用に戻しました（ユーザー操作の受付を再開）');
});

/* ── 初期化 ───────────────────────────── */
loadFrames();
loadDisk();
loadSettings();
refreshFailedCount();
checkDiagBadge();
setInterval(loadDisk, 30_000);
setInterval(refreshFailedCount, 30_000);
setInterval(checkDiagBadge, 20_000);

// どのタブにいてもエラー検知でタブにバッジ＆（再起動タブ表示中なら）ポップアップ
async function checkDiagBadge() {
  const diag = await api.get('/diagnose').catch(() => null);
  $('#restart-badge').hidden = !(diag && diag.hasError);
  if (!$('#tab-restart').hidden) maybePopupDiag(diag);
}
