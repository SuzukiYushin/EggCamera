/* Photo Booth 管理画面 */
const $ = sel => document.querySelector(sel);

const api = {
  async get(path)        { return req(path); },
  async del(path)        { return req(path, { method: 'DELETE' }); },
  async patch(path, b)   { return req(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
  async post(path, b)    { return req(path, { method: 'POST',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
  async put(path, b)     { return req(path, { method: 'PUT',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
};
async function req(path, init) {
  const res = await fetch(`/api/admin${path}`, init);
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
    for (const id of ['frames', 'photo', 'logs']) {
      $(`#tab-${id}`).hidden = btn.dataset.tab !== id;
    }
    if (btn.dataset.tab === 'logs') startLogPolling(); else stopLogPolling();
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

/* ── 初期化 ───────────────────────────── */
loadFrames();
loadDisk();
loadSettings();
setInterval(loadDisk, 30_000);
