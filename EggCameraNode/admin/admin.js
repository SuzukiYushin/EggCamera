/* Photo Booth 管理画面 */
const $ = sel => document.querySelector(sel);

// 完成画像のアスペクト。iPhone の画面比(1179:2556 ≒ 19.5:9)で縦いっぱい = 2768×6000。
// サーバ合成(src/compose.js の TARGET_ASPECT)と必ず同じ値にすること。ズレるとクロップ
// プレビュー(WYSIWYG)と実際の完成画像の画角が食い違う。
const TARGET_ASPECT = 2768 / 6000;

// 管理APIにトークンが要る場合: ?token=… を一度開くと localStorage に保存し、
// 以降は自動付与する。トークン無効なら従来どおり素通り。
const ADMIN_TOKEN = (() => {
  const p = new URLSearchParams(location.search).get('token');
  if (p) localStorage.setItem('adminToken', p);
  return localStorage.getItem('adminToken') || '';
})();
// img/aタグ用。Basic認証ではブラウザが認証後の全リクエスト（画像含む）へ自動で
// Authorization ヘッダーを付けるため、トークンをURLに出さない。
// （?token= でブートストラップした場合の後方互換のみ付与）
function withToken(url) {
  const boot = new URLSearchParams(location.search).get('token');
  if (!boot) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(boot);
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
  if (res.status === 401) throw new Error('unauthorized（再読み込みしてログインし直してください）');
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
    for (const id of ['frames', 'photo', 'failed', 'restart', 'logs']) {
      $(`#tab-${id}`).hidden = btn.dataset.tab !== id;
    }
    if (btn.dataset.tab === 'logs') startLogPolling(); else stopLogPolling();
    if (btn.dataset.tab === 'failed') { loadFailed(); startJobsPolling(); } else stopJobsPolling();
    if (btn.dataset.tab === 'restart') loadRestart();
    if (btn.dataset.tab !== 'photo') stopLiveView(); // 写真タブを離れたらライブビュー停止（ストリーム切断）
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
      <button class="del" title="削除">x</button>`;
    card.querySelector('.name').textContent = f.name;
    card.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`「${f.name}」を一覧から削除しますか？\n（ファイルは Mac mini 内に残ります）`)) return;
      await api.del(`/frames/${f.id}`);
      loadFrames();
    });
    grid.appendChild(card);
  }
}

/* ── 成長するファミちゃん（年齢連動9種＋レア2種） ── */
async function loadGrowthFrames() {
  let data;
  try { data = await api.get('/growth-frames'); } catch { return; }
  const section = $('#growth-section');
  if (!data || !data.growth || !data.growth.length) { section.hidden = true; return; }
  section.hidden = false;
  const pct = Math.round((data.rareProbability || 0) * 100);
  $('#growth-hint').textContent =
    `生後日数(days)に応じて9種類を自動選択し、レアは約${pct}%でランダム表示します。`
    + (data.enabled
        ? '【現在このモードが有効です／上のランダム一覧より優先されます】'
        : '【現在は無効。.env に GROWTH_FRAMES=1 を設定して再起動すると有効化されます（既定は無効＝上のランダム一覧が使われます）】');
  const fill = (sel, items, labelFn) => {
    const grid = $(sel);
    grid.innerHTML = '';
    for (const f of items) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<img class="thumb" src="${f.url}" alt=""><div class="name"></div>`;
      card.querySelector('.name').textContent = labelFn(f);
      grid.appendChild(card);
    }
  };
  fill('#growth-grid', data.growth, f => `Lv${f.level}・${f.minDays}〜${f.maxDays}days`);
  fill('#rare-grid',   data.rare,   f => f.label);
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

/* ── 写真設定（ライブビュー＋クロップ調整） ────── */
let testImage = null;
let savedCrop = { zoom: 1, offsetX: 0, offsetY: 0 };
// ズームゲージの無劣化範囲表示用。GET /settings の meta で上書きされる。
let zoomMeta = { captureLongEdge: 8064, outputLongEdge: 3600 };

async function loadSettings() {
  try {
    const s = await api.get('/settings');
    savedCrop = s.crop;
    if (s.meta) zoomMeta = s.meta;
    $('#crop-zoom').value = s.crop.zoom;
    $('#crop-zoom-range').value = s.crop.zoom;
    $('#crop-ox').value = s.crop.offsetX;
    $('#crop-oy').value = s.crop.offsetY;
    updateZoomGauge();
  } catch {}
}

function currentCrop() {
  return {
    zoom:    parseFloat($('#crop-zoom').value) || 1,
    offsetX: parseFloat($('#crop-ox').value) || 0,
    offsetY: parseFloat($('#crop-oy').value) || 0,
  };
}

/* 合成段と同じクロップ計算（TARGET_ASPECT cover → offset 適用）。
   完成画像は iPhone 画面比(2768:6000)。compose.js の TARGET_ASPECT と揃えること。
   ズームは撮影時にカメラ(videoZoomFactor)で適用済みのため、ここでは zoom=1（pan のみ）。 */
function drawCropPreview() {
  if (!testImage) return;
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const { offsetX, offsetY } = currentCrop();

  const targetAspect = TARGET_ASPECT;
  const iw = testImage.naturalWidth, ih = testImage.naturalHeight;
  let cw, ch;
  if (iw / ih > targetAspect) { ch = ih; cw = ch * targetAspect; }
  else { cw = iw; ch = cw / targetAspect; }

  // ライブ映像は既にカメラ側でズーム済み → デジタルズーム=1。offset(pan)のみ反映してWYSIWYGに。
  let rw = cw, rh = ch;
  let rx = (iw - cw) / 2 + (offsetX / 100) * rw;
  let ry = (ih - ch) / 2 + (offsetY / 100) * rh;
  rx = Math.max(0, Math.min(rx, iw - rw));
  ry = Math.max(0, Math.min(ry, ih - rh));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(testImage, rx, ry, rw, rh, 0, 0, canvas.width, canvas.height);
}

// ズームゲージ更新: 無劣化上限と現在値の実情報MPを表示し、レンジ背景を色分けする。
function updateZoomGauge() {
  const z = parseFloat($('#crop-zoom').value) || 1;
  const lossless = zoomMeta.captureLongEdge / zoomMeta.outputLongEdge; // 例 8064/6000≈1.34
  const capMP = (zoomMeta.captureLongEdge * (zoomMeta.captureLongEdge * TARGET_ASPECT)) / 1e6; // 撮影の有効域
  const outMP = (zoomMeta.outputLongEdge * (zoomMeta.outputLongEdge * TARGET_ASPECT)) / 1e6;   // 完成画像
  const effMP = capMP / (z * z);                                       // ズーム後の実情報
  const range = $('#crop-zoom-range');
  if (range) {
    const lo = parseFloat(range.min), hi = parseFloat(range.max);
    const pct = Math.max(0, Math.min(100, ((lossless - lo) / (hi - lo)) * 100));
    range.style.background =
      `linear-gradient(to right, #8fd19e 0%, #8fd19e ${pct}%, #f3d27a ${pct}%, #f3d27a 100%)`;
  }
  const el = $('#zoom-quality');
  if (el) {
    const degraded = z > lossless + 1e-9;
    el.textContent =
      `${z.toFixed(2)}倍 ｜ 実情報 ${effMP.toFixed(1)}MP / 完成 ${outMP.toFixed(1)}MP ｜ 無劣化上限 ${lossless.toFixed(2)}倍`
      + (degraded ? '（軽度アップスケール）' : '（無劣化）');
    el.className = degraded ? 'zoom-quality warn' : 'zoom-quality';
  }
}

// ズーム値をライブビュー中のカメラへデバウンス送信（撮影前にプレビューへ反映）
let zoomWakeTimer = null;
function pushZoomToCamera() {
  if (!liveTimer) return; // ライブビュー中のみ（停止中はカメラを起こさない）
  const z = parseFloat($('#crop-zoom').value) || 1;
  clearTimeout(zoomWakeTimer);
  zoomWakeTimer = setTimeout(() => {
    fetch(withToken(`/api/preview/wake?zoom=${z}`), { method: 'POST' }).catch(() => {});
  }, 250);
}

function onCropInput() {
  // 数値入力時はレンジを追従させる（レンジ操作時は range 側で数値を更新済み）
  const zr = $('#crop-zoom-range');
  if (zr && document.activeElement !== zr) zr.value = $('#crop-zoom').value;
  drawCropPreview();
  updateZoomGauge();
  pushZoomToCamera();
  // 値を変えたら古い「保存しました」を消して未保存を明示
  const status = $('#crop-status');
  status.className = 'status';
  status.textContent = '未保存の変更があります';
}

// 数値入力 ↔ レンジスライダーの双方向同期
$('#crop-zoom-range').addEventListener('input', () => {
  $('#crop-zoom').value = $('#crop-zoom-range').value;
  onCropInput();
});

['crop-zoom', 'crop-ox', 'crop-oy'].forEach(id => {
  $(`#${id}`).addEventListener('input', onCropInput);
});

/* ── ライブビュー（撮影設定: クロップ調整用） ──────────
   テスト撮影（単発）の代わりに、iPhone の MJPEG ライブ映像を流し続けて、
   クロップ（zoom/offset）を反映した結果を canvas にライブ描画する。
   ・映像取得は MJPEG ストリーム1本（=1接続）。レート制限にも優しい。
   ・stream/frame/wake は core(:3000) の /api/preview/*。admin(:3001) が中継する。
   ・preview は管理トークン不要だが、?token= ブートストラップ時のため withToken を通す。 */
const liveImg = $('#liveview-src');   // 非表示の MJPEG 受け皿
let liveTimer = null;                 // 描画ループ（null=停止中）

/* ── 低照度警告 ──
   iOSは暗所で48MP→12MPへ自動ビニングする（コード側では防げない）ため、
   ライブ映像の平均輝度から画質低下リスクをスタッフに可視化する。閾値は経験則。 */
const LUX_LOW = 60;  // これ未満 = 低照度（12MP化のおそれ）
const LUX_DIM = 85;  // これ未満 = やや暗め
const luxCanvas = document.createElement('canvas');
luxCanvas.width = 48; luxCanvas.height = 72;
function updateLuxIndicator() {
  const el = $('#lux-indicator');
  if (!el || !liveImg.naturalWidth) return;
  let mean;
  try {
    const ctx = luxCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(liveImg, 0, 0, luxCanvas.width, luxCanvas.height);
    const d = ctx.getImageData(0, 0, luxCanvas.width, luxCanvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    mean = sum / (d.length / 4);
  } catch { return; }
  el.hidden = false;
  if (mean < LUX_LOW) {
    el.textContent = `⚠ 低照度（平均輝度 ${mean.toFixed(0)}/255）: 48MP→12MPに落ちるおそれ。照明を明るくしてください`;
    el.className = 'lux-indicator low';
  } else if (mean < LUX_DIM) {
    el.textContent = `やや暗め（平均輝度 ${mean.toFixed(0)}/255）: 画質低下に注意`;
    el.className = 'lux-indicator dim';
  } else {
    el.textContent = `照度OK（平均輝度 ${mean.toFixed(0)}/255）`;
    el.className = 'lux-indicator ok';
  }
}

function stopLiveView() {
  if (!liveTimer && !(liveImg && liveImg.src)) return; // 動いていなければ何もしない
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  // 停止後もスライダーでクロップ調整できるよう、最後のフレームを静止画として保持する。
  // （proxy 経由＝同一オリジンなので canvas は汚染されず toDataURL 可能）
  if (liveImg && liveImg.naturalWidth) {
    try {
      const off = document.createElement('canvas');
      off.width = liveImg.naturalWidth;
      off.height = liveImg.naturalHeight;
      off.getContext('2d').drawImage(liveImg, 0, 0);
      const frozen = new Image();
      frozen.onload = () => { testImage = frozen; drawCropPreview(); };
      frozen.src = off.toDataURL('image/jpeg', 0.92);
    } catch { /* 取得できなくても直近の canvas 描画は残る */ }
  }
  if (liveImg) liveImg.src = '';      // ストリーム切断（接続スロットを解放）
  const lux = $('#lux-indicator');
  if (lux) lux.hidden = true;         // 輝度表示は停止中は非表示（静止画では判定しない）
  const btn = $('#btn-liveview');
  if (btn) { btn.textContent = 'ライブビュー開始'; btn.style.background = ''; }
  const status = $('#crop-status');
  if (status && status.classList.contains('err') === false) {
    status.className = 'status';
    status.textContent = 'ライブビュー停止中';
  }
}

function startLiveView() {
  const btn = $('#btn-liveview');
  const status = $('#crop-status');
  // カメラ先行起動（黒画面の短縮）。失敗しても撮影/プレビュー時に遅延起動するので無視。
  fetch(withToken(`/api/preview/wake?zoom=${parseFloat($('#crop-zoom').value) || 1}`), { method: 'POST' }).catch(() => {});
  status.className = 'status';
  status.textContent = 'ライブビュー接続中…';
  liveImg.onerror = () => {
    status.className = 'status err';
    status.textContent = 'ライブビュー接続に失敗（カメラ未接続の可能性）';
    stopLiveView();
  };
  liveImg.src = withToken('/api/preview/stream');
  testImage = liveImg;                 // drawCropPreview の入力をライブ映像に
  // MJPEG は1フレームごとに自動更新される。canvas へ ~10fps で描画してクロップを反映。
  let liveTick = 0;
  liveTimer = setInterval(() => {
    if (!liveImg.naturalWidth) return; // 最初のフレーム未到達
    $('#crop-placeholder').hidden = true;
    if (status.textContent === 'ライブビュー接続中…') status.textContent = 'ライブビュー中（クロップを調整して保存）';
    drawCropPreview();
    if (++liveTick % 10 === 0) updateLuxIndicator(); // 約1秒ごとに輝度判定
  }, 100);
  btn.textContent = 'ライブビュー停止';
  btn.style.background = '#E0556E';    // 停止＝赤系
}

$('#btn-liveview').addEventListener('click', () => {
  if (liveTimer) stopLiveView(); else startLiveView();
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
      <img class="thumb" src="${withToken(it.url)}" alt="" style="aspect-ratio:2768/6000;object-fit:cover;">
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

/* ── サーバ合成ジョブ（処理中・要確認）。数秒ごとにポーリングしてリアルタイム表示 ── */
const JOB_STATUS_LABELS = {
  queued:           '待機中',
  composing:        '合成中',
  composite_failed: '合成失敗（再試行中）',
  uploading:        'アップロード中',
  upload_failed:    'アップロード失敗（再試行中）',
  done:             '完了',
};

// 画像を Image としてロード（同一オリジンなので canvas は tainted にならず toBlob 可能）
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = src;
  });
}
// 認証付きで composite/source を blob 取得（Basic認証はブラウザ自動・?token= は後方互換）
async function fetchBlob(path) {
  const res = await fetch(withToken(path), {
    headers: ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {},
  });
  if (!res.ok) throw new Error(`fetch_${res.status}`);
  return res.blob();
}
// canvas.toBlob（48MP写真でメモリ圧によりnullになることがあるので数回バックオフ・リトライ）
function exportCanvas(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}
async function canvasToBlobRetry(canvas) {
  for (let i = 1; i <= 4; i++) {
    const blob = await exportCanvas(canvas);
    if (blob) return blob;
    await new Promise(r => setTimeout(r, 250 * i));
  }
  throw new Error('canvas_toblob_null');
}
// 署名付きURLへ直接PUT（管理PCの回線でR2へ。X-Admin-Token は付けない＝署名外ヘッダで失敗するため）
async function putToPresigned(uploadUrl, blob) {
  const res = await fetch(uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
  });
  if (!res.ok) throw new Error(`put_${res.status}`);
}
// PCローカルへ保存（ダウンロード）
function saveBlobToPC(blob, fileName) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
// ブラウザ canvas 合成（compose.js と同じレイアウト：TARGET_ASPECTクロップ＋フレーム＋名前/日数）。
// フレームは全フレームからランダムで1枚選ぶ（旧 FinalPreview と同じ）。名前・日数も焼き込む。
async function recomposeToBlob(params) {
  const srcImg = await loadImage(withToken(params.sourceUrl));
  const frames = await api.get('/frames').catch(() => []);
  const frameUrl = frames.length
    ? frames[Math.floor(Math.random() * frames.length)].url
    : '/frames/flame_sample.png';
  const frameImg = await loadImage(withToken(frameUrl));

  const TARGET = TARGET_ASPECT;
  const iw = srcImg.naturalWidth, ih = srcImg.naturalHeight;
  let cw, ch;
  if (iw / ih > TARGET) { ch = ih; cw = ch * TARGET; } else { cw = iw; ch = cw / TARGET; }
  cw = Math.round(cw); ch = Math.round(ch);
  const crop = params.crop || { zoom: 1, offsetX: 0, offsetY: 0 };
  const zoom = crop.zoom || 1, offX = crop.offsetX || 0, offY = crop.offsetY || 0;
  const rw = cw / zoom, rh = ch / zoom;
  let rx = (iw - cw) / 2 + (cw - rw) / 2 + (offX / 100) * rw;
  let ry = (ih - ch) / 2 + (ch - rh) / 2 + (offY / 100) * rh;
  rx = Math.max(0, Math.min(rx, iw - rw));
  ry = Math.max(0, Math.min(ry, ih - rh));
  const left   = Math.max(0, Math.min(Math.round(rx), iw - 1));
  const top    = Math.max(0, Math.min(Math.round(ry), ih - 1));
  const width  = Math.max(1, Math.min(Math.round(rw), iw - left));
  const height = Math.max(1, Math.min(Math.round(rh), ih - top));

  const canvas = $('#recompose-canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(srcImg, left, top, width, height, 0, 0, cw, ch); // 写真（2:3クロップ）
  ctx.drawImage(frameImg, 0, 0, cw, ch);                          // フレーム（伸ばして重ね）

  // 文字（compose.js buildTextSvg 準拠。設計幅 413 基準の固定スケール k）
  const k = cw / 413, x = 50 * k;
  let y = ch * 0.58;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  if (params.nickname) {
    const fsize = 50 * k;
    ctx.font = `900 ${fsize}px 'Hiragino Kaku Gothic Pro','Hiragino Sans',sans-serif`;
    ctx.lineWidth = 2 * k; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
    try { ctx.letterSpacing = `${-0.01 * fsize}px`; } catch {}
    ctx.strokeText(params.nickname, x, y);
    ctx.fillText(params.nickname, x, y);
    y += fsize * 1.1 + 1 * k;
  }
  if (params.daysText) {
    const fsize = 28 * k;
    ctx.font = `600 ${fsize}px 'Futura','Century Gothic',sans-serif`;
    ctx.lineWidth = 0.6 * k; ctx.strokeStyle = 'rgba(0,0,0,0.95)'; ctx.fillStyle = 'rgba(0,0,0,0.95)';
    try { ctx.letterSpacing = `${0.01 * fsize}px`; } catch {}
    for (const line of String(params.daysText).split('\n')) {
      ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
      y += fsize * 1.2;
    }
  }
  try { ctx.letterSpacing = '0px'; } catch {} // 後続描画に残さない
  return canvasToBlobRetry(canvas);
}

async function loadJobs() {
  const grid = $('#jobs-grid');
  if (!grid) return;
  const items = await api.get('/jobs').catch(() => []);
  $('#jobs-empty').style.display = items.length ? 'none' : '';
  grid.innerHTML = '';
  for (const it of items) grid.appendChild(buildJobCard(it));
}

function buildJobCard(it) {
  const captured = new Date(it.capturedAt).toLocaleString('ja-JP');
  const label = JOB_STATUS_LABELS[it.status] || it.status;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <img class="thumb" src="${withToken(it.imageUrl)}" alt="" style="aspect-ratio:2/3;object-fit:cover;">
    <div class="name"></div>
    <div class="failed-when job-status"></div>
    <div class="failed-when job-meta"></div>
    <div class="failed-actions"></div>
    <div class="job-msg" style="font-size:12px;margin-top:4px;color:#555;"></div>`;
  card.querySelector('.name').textContent = it.fileName + (it.attentionRequired ? '  ⚠要対応' : '');
  const st = card.querySelector('.job-status');
  st.textContent = `状態: ${label}${it.lastError ? `（${it.lastError}）` : ''}`;
  st.style.color = it.status === 'done' ? '#1a7f37'
    : (it.status === 'composite_failed' || it.status === 'upload_failed' || it.attentionRequired) ? '#FF4E50' : '';
  card.querySelector('.job-meta').textContent =
    `撮影: ${captured}` + (it.uploadedAt ? ` / 完了: ${new Date(it.uploadedAt).toLocaleString('ja-JP')}` : '');

  const actions = card.querySelector('.failed-actions');
  const msg = card.querySelector('.job-msg');

  if (it.status === 'composite_failed' || (it.manualMode === 'recompose' && it.status !== 'done')) {
    addRecomposeButton(actions, msg, it);                 // 合成失敗 → 再合成
  } else if (it.status === 'upload_failed' || (it.manualMode === 'reupload' && it.status !== 'done')) {
    addReuploadButtons(actions, msg, it);                 // アップロード失敗 → ダウンロード＋再送
  } else {
    const dl = document.createElement('a');               // 自動処理中 or 完了：DLリンクのみ
    dl.className = 'badge active'; dl.textContent = 'ダウンロード'; dl.download = '';
    dl.href = withToken(`${it.imageUrl}?download=1`);
    actions.appendChild(dl);
  }

  if (it.qrDataUrl) {
    const qr = document.createElement('img');
    qr.src = it.qrDataUrl; qr.alt = 'DL QR';
    qr.title = 'ダウンロード用QR（お客様に提示）';
    qr.style.cssText = 'width:84px;height:84px;margin-top:6px;border-radius:6px;background:#fff;';
    card.appendChild(qr);
  }
  return card;
}

// アップロード失敗の再送UI: ①ダウンロード(blob/presignを切替前に保持＋PC保存) → ②再送(直PUT)
function addReuploadButtons(actions, msg, it) {
  let blob = null, presign = null;
  const dlBtn = document.createElement('button');
  dlBtn.className = 'badge'; dlBtn.textContent = '① ダウンロード（再送準備）';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'badge active'; sendBtn.textContent = '② 再送'; sendBtn.disabled = true;
  actions.appendChild(dlBtn); actions.appendChild(sendBtn);

  dlBtn.addEventListener('click', async () => {
    dlBtn.disabled = true; msg.style.color = '#555'; msg.textContent = '準備中…';
    stopJobsPolling(); // 操作中はポーリングでカードが作り直されないよう停止
    try {
      presign = await api.post(`/jobs/${it.jobId}/presign`, { mode: 'reupload' });
      blob = await fetchBlob(it.imageUrl);
      saveBlobToPC(blob, it.fileName);
      sendBtn.disabled = false;
      msg.textContent = 'ダウンロード完了。PCのネットワークを切り替えてから「② 再送」を押してください。';
    } catch (err) {
      dlBtn.disabled = false; msg.style.color = '#FF4E50';
      msg.textContent = '準備失敗: ' + err.message;
      startJobsPolling();
    }
  });

  sendBtn.addEventListener('click', async () => {
    if (!blob || !presign) return;
    sendBtn.disabled = true; msg.style.color = '#555';
    msg.textContent = '再送中…（このPCの回線でR2へ直接送信）';
    try {
      await putToPresigned(presign.uploadUrl, blob);
      msg.textContent = '再送しました。完了を確認中…（ネットを戻すと即時、または30秒ほどで自動反映）';
      // ネット復帰していれば即時反映（失敗してもサーバのHEAD確認ループが done 化する）
      api.post(`/jobs/${it.jobId}/complete`, { via: 'reupload' }).catch(() => {});
      setTimeout(() => { loadJobs(); startJobsPolling(); }, 2500);
    } catch (err) {
      sendBtn.disabled = false; msg.style.color = '#FF4E50';
      msg.textContent = '再送失敗: ' + err.message + '（署名URLの期限切れなら「① ダウンロード」からやり直してください）';
    }
  });
}

// 合成失敗の再合成UI: ブラウザ合成（名前/日数/ランダムフレーム）→ 直PUT → 完了通知
function addRecomposeButton(actions, msg, it) {
  const btn = document.createElement('button');
  btn.className = 'badge active'; btn.textContent = '再合成';
  actions.appendChild(btn);
  btn.addEventListener('click', async () => {
    btn.disabled = true; msg.style.color = '#555'; msg.textContent = '合成中…（このPCで合成し直しています）';
    stopJobsPolling();
    try {
      const params  = await api.get(`/jobs/${it.jobId}/params`);
      const presign = await api.post(`/jobs/${it.jobId}/presign`, { mode: 'recompose' });
      const blob = await recomposeToBlob(params);
      saveBlobToPC(blob, it.fileName); // 再ダウンロード用にPCへも保存
      msg.textContent = 'アップロード中…';
      await putToPresigned(presign.uploadUrl, blob);
      await api.post(`/jobs/${it.jobId}/complete`, { via: 'recompose' }).catch(() => {});
      msg.style.color = '#1a7f37';
      msg.textContent = '完了しました。表示されたQRをお客様に提示してください。';
      setTimeout(() => { loadJobs(); startJobsPolling(); }, 1800);
    } catch (err) {
      btn.disabled = false; msg.style.color = '#FF4E50';
      msg.textContent = '再合成失敗: ' + err.message;
      startJobsPolling();
    }
  });
}

let jobsTimer = null;
function startJobsPolling() { if (jobsTimer) return; loadJobs(); jobsTimer = setInterval(loadJobs, 3000); }
function stopJobsPolling()  { clearInterval(jobsTimer); jobsTimer = null; }

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
loadGrowthFrames();
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
