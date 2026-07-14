// ── サーバ側 最終画像合成エンジン（Phase 1） ───────────────────────────────
// 旧来クライアント(FinalPreview.tsx)の canvas 合成をサーバへ移植したもの。
// 写真の 2:3 クロップ(zoom/offset) + フレーム + ニックネーム/days 文字を sharp で
// 原寸合成し、完成画像 JPEG を返す。文字はシステムフォント(Hiragino/Futura)を使う
// SVG テキストレイヤーを重ねる（厳密一致でなくデザイン準拠・目視調整前提）。
const os    = require('node:os');
const { spawn } = require('node:child_process');
const path  = require('node:path');
const fs    = require('node:fs');
const sharp = require('sharp');
// libvips のオペレーションキャッシュを無効化し合成のネイティブメモリ滞留を抑える(出力品質・解像度は不変)。
// 合成は composeInChild で子プロセスへ隔離するが、子側でも本設定を効かせる。
sharp.cache(false);
sharp.concurrency(1);
const { heicToJpeg } = require('./capture');

// ── クライアント FinalPreview.tsx から移植したレイアウト定数 ────────────────
// 文字サイズ/位置は「設計上の写真コンテナ幅(px)」基準。クライアントは
// containerWidthDesign(=実DOM幅/scale)で k=cw/containerWidthDesign を作るが、
// サーバには DOM が無いので設計コンテナ幅を定数化する（768x1024 設計・2:3コンテナ）。
// ※初期値は概算。サンプル目視で微調整する想定（TUNABLE）。
const DESIGN_PHOTO_W = 413;       // TUNABLE: 設計空間での写真コンテナ幅(px)
const NAME_TOP_RATIO       = 0.58;
const NAME_LEFT_PX         = 50;
const NICKNAME_FONT_PX     = 50;
const NICKNAME_LINE_HEIGHT = 1.1;
const DAYS_FONT_PX         = 28;
const DAYS_LINE_HEIGHT     = 1.2;
const TEXT_GAP_PX          = 1;
// 完成画像のアスペクト。iPhone の画面比(1179:2556 ≒ 19.5:9)で縦いっぱいに切る＝
// スマホの壁紙/全画面表示で余白なく収まる。高さ 6000 なら 2768×6000。
// 旧値は 2/3(=4000×6000)。変更時は成長フレーム(gen-growth-frames.js)と
// UI プレビュー(FinalPreviewServer/FinalPreview)のアスペクトも合わせること。
const TARGET_ASPECT        = 2768 / 6000;

// 出力(完成画像)の最大高さ(px)。縦長なので高さが長辺。これを超える出力は縮小する。
// 無キャップだと 48MP 撮影の原寸クロップがそのまま出力寸法になり、1合成で写真/フレーム/合成の
// 各レイヤをそのぶんネイティブ確保 → RSS が膨張する。現行は 6000(=2768×6000, 約16.6MP)。
// 配信画質を変える値なので調整可（小さくするほど軽い: 3600=1661×3600≒6MP 等）。
const MAX_OUTPUT_HEIGHT    = parseInt(process.env.COMPOSE_MAX_HEIGHT || '3600', 10);

// CSS の --font-heading / --font-futura に対応するシステムフォント。
const FONT_HEADING = "'Hiragino Kaku Gothic Pro', 'Hiragino Sans', sans-serif";
const FONT_FUTURA  = "'Futura', 'Century Gothic', sans-serif";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const xmlEsc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// ── クロップ枠(TARGET_ASPECT・出力寸法) と ソース矩形を算出（FinalPreview.tsx:116-143 移植）──
function computeCropGeometry(iw, ih, crop) {
    let cw, ch;
    if (iw / ih > TARGET_ASPECT) { ch = ih; cw = ch * TARGET_ASPECT; }
    else                         { cw = iw; ch = cw / TARGET_ASPECT; }
    cw = Math.round(cw);
    ch = Math.round(ch);

    const zoom = crop?.zoom || 1;
    const offX = crop?.offsetX || 0;
    const offY = crop?.offsetY || 0;
    const rw = cw / zoom;
    const rh = ch / zoom;
    let rx = (iw - cw) / 2 + (cw - rw) / 2 + (offX / 100) * rw;
    let ry = (ih - ch) / 2 + (ch - rh) / 2 + (offY / 100) * rh;
    rx = clamp(rx, 0, iw - rw);
    ry = clamp(ry, 0, ih - rh);

    // sharp.extract は整数・画像内に収める
    const left   = clamp(Math.round(rx), 0, iw - 1);
    const top    = clamp(Math.round(ry), 0, ih - 1);
    const width  = clamp(Math.round(rw), 1, iw - left);
    const height = clamp(Math.round(rh), 1, ih - top);
    return { cw, ch, extract: { left, top, width, height } };
}

// ── 文字レイヤー(SVG) を作る。stroke を fill の下に置くため text を2重描画する ──
function buildTextSvg(cw, ch, nickname, daysText) {
    const k = cw / DESIGN_PHOTO_W;
    const x = NAME_LEFT_PX * k;
    let y = ch * NAME_TOP_RATIO;
    const parts = [];

    const textEl = (str, yTop, fontSize, family, weight, color, strokeW, letterSpacing) => {
        const common =
            `x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" font-family="${family}" ` +
            `font-weight="${weight}" font-size="${fontSize.toFixed(1)}" ` +
            `letter-spacing="${letterSpacing.toFixed(2)}" ` +
            `dominant-baseline="text-before-edge" xml:space="preserve"`;
        const safe = xmlEsc(str);
        // 下: 縁取りのみ / 上: 塗りのみ（client の strokeText→fillText を再現）
        return (
            `<text ${common} fill="none" stroke="${color}" stroke-width="${strokeW.toFixed(2)}" ` +
            `stroke-linejoin="round">${safe}</text>` +
            `<text ${common} fill="${color}" stroke="none">${safe}</text>`
        );
    };

    if (nickname) {
        const fs = NICKNAME_FONT_PX * k;
        parts.push(textEl(nickname, y, fs, FONT_HEADING, 900, '#000000', 2 * k, -0.01 * fs));
        y += fs * NICKNAME_LINE_HEIGHT + TEXT_GAP_PX * k;
    }
    if (daysText) {
        const fs = DAYS_FONT_PX * k;
        for (const line of String(daysText).split('\n')) {
            parts.push(textEl(line, y, fs, FONT_FUTURA, 600, 'rgba(0,0,0,0.95)', 0.6 * k, 0.01 * fs));
            y += fs * DAYS_LINE_HEIGHT;
        }
    }

    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" ` +
        `viewBox="0 0 ${cw} ${ch}">${parts.join('')}</svg>`,
    );
}

// ── HEIC等を sharp が扱える JPEG パスへ（既存方針: HEIC は sips 変換） ──────
// 一時ファイル名は pid+連番で一意化する。basename はジョブ間で重複する（jobs 配下の
// ソースは全件 source.heic）ため、basename だけだと worker 再合成と管理画面の
// source.jpg 表示が並走したとき同一 /tmp パスへ二重書き込み＋削除交錯が起こり、
// 別ジョブの写真で合成/破損画像を生みうる。
let tmpSeq = 0;
async function ensureRasterSource(sourcePath) {
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
        return { rasterPath: sourcePath, cleanup: false };
    }
    const tmp = path.join(os.tmpdir(),
        `eggcompose_${process.pid}_${++tmpSeq}_${path.basename(sourcePath)}.jpg`);
    await heicToJpeg(sourcePath, tmp);
    return { rasterPath: tmp, cleanup: true };
}

// ── 最終画像を合成して JPEG バッファを返す ───────────────────────────────
// opts: { sourcePath, framePath, crop:{zoom,offsetX,offsetY}, nickname, daysText }
async function composeFinalImage({ sourcePath, framePath, crop, nickname, daysText }) {
    const { rasterPath, cleanup } = await ensureRasterSource(sourcePath);
    try {
        const meta = await sharp(rasterPath).metadata();

        // iPhone は縦持ちでも「横バッファ + EXIF orientation=6」で吐き、sips の HEIC→JPEG は
        // その向きをタグのまま素通しする（画素は回さない）。sharp は EXIF を自動適用しないため、
        // .rotate()(=EXIF自動回転) を挟まないと extract が回転前の座標系で走り完成画像が90°倒れる。
        // metadata の width/height も回転前の値なので、正立後の寸法に読み替えてから幾何計算する。
        const upright = meta.orientation >= 5;   // 5..8 = 90/270度回転を伴う向き
        const iw = upright ? meta.height : meta.width;
        const ih = upright ? meta.width  : meta.height;
        const { cw, ch, extract } = computeCropGeometry(iw, ih, crop);

        // 出力解像度をキャップ(メモリ有界化)。アスペクトを保ったまま長辺(高さ)を上限に収める。
        // extract は原寸座標のまま＝libvips が原寸クロップ領域を縮小出力するだけ。これにより
        // 写真/フレーム/合成の各レイヤ確保が出力寸法ぶんで済み、1合成のネイティブ確保を抑える。
        // 拡大はしない（ch < MAX なら実解像度のまま出す＝偽の解像度を作らない）。
        let outW = cw, outH = ch;
        if (outH > MAX_OUTPUT_HEIGHT) {
            outH = MAX_OUTPUT_HEIGHT;
            outW = Math.round(outH * TARGET_ASPECT);
        }

        // 1) 写真を正立 → TARGET_ASPECT クロップ → 出力寸法へ
        //    .rotate() は extract より先に適用される（実測確認済み）。
        const photo = await sharp(rasterPath)
            .rotate()
            .extract(extract)
            .resize(outW, outH, { fit: 'fill' })
            .toBuffer();

        // 2) フレームを出力寸法へ伸ばす
        const frame = await sharp(framePath)
            .resize(outW, outH, { fit: 'fill' })
            .png()
            .toBuffer();

        // 3) 文字レイヤー
        const text = buildTextSvg(outW, outH, nickname, daysText);

        const buffer = await sharp(photo)
            .composite([
                { input: frame, blend: 'over' },
                { input: text,  blend: 'over' },
            ])
            .jpeg({ quality: 95 })
            .toBuffer();

        return { buffer, width: outW, height: outH };
    } finally {
        if (cleanup) fs.rm(rasterPath, { force: true }, () => {});
    }
}

// ── 完成画像からプレビュー用サムネ(dataURL)を作る ────────────────────────
async function makeThumbnailDataUrl(finalBuffer, maxSide = 1080) {
    const thumb = await sharp(finalBuffer)
        .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    return `data:image/jpeg;base64,${thumb.toString('base64')}`;
}

// ── 完成画像からDLページ先行表示用の縮小版(JPEGバッファ)を作る ──────────────
// スマホ回線でフル解像度(~2MB)の読込を待たせないため、軽量版(数十KB)を先に表示する。
// R2 へ `<fileName>_preview.jpg` として本画像の後にアップロードされる(uploadWorker)。
async function makeDlPreviewJpeg(finalBuffer, maxSide = 900) {
    return sharp(finalBuffer)
        .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
}

// ── 合成を独立プロセスで実行し、終了時に libvips/sharp のネイティブメモリを完全解放する ──
// 親(Node本体)で composeFinalImage を直接呼ぶと libvips のワーキングセットが RSS に高止まりする
// (完成画像4000×6000で顕著)。子プロセスへ隔離し、合成ごとに解放してアイドル時 baseline へ戻す。
// composite.jpg は子が outPath へ直接書く。stdin に JSON、stdout に {width,height,thumbDataUrl}。
function composeInChild(opts) {
    return new Promise((resolve, reject) => {
        const worker = path.join(__dirname, 'composeWorker.js');
        // 結果は一時ファイルで受け渡す。子の stdout は環境系ツール等の起動時診断出力で汚染され得る
        // (例: '◇ injected env ...')ため stdout は捨て(ignore)、JSON.parse への混入を防ぐ。
        const resultPath = path.join(os.tmpdir(),
            `composeres_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}.json`);
        const cleanup = () => { try { fs.rmSync(resultPath, { force: true }); } catch {} };
        const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { cleanup(); reject(e); });
        child.on('close', code => {
            if (code !== 0) { cleanup(); return reject(new Error(`composeWorker exit ${code}: ${err.slice(0, 500)}`)); }
            try {
                const r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                cleanup();
                resolve(r);
            } catch (e) { cleanup(); reject(new Error(`composeWorker result read failed: ${e.message}`)); }
        });
        child.stdin.on('error', () => {}); // 子が即死した場合の EPIPE を握りつぶす
        child.stdin.write(JSON.stringify({ ...opts, resultPath }));
        child.stdin.end();
    });
}

module.exports = {
    composeFinalImage,
    composeInChild,
    makeThumbnailDataUrl,
    makeDlPreviewJpeg,
    computeCropGeometry,
    buildTextSvg,
    ensureRasterSource,
    DESIGN_PHOTO_W,
};
