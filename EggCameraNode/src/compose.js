// ── サーバ側 最終画像合成エンジン（Phase 1） ───────────────────────────────
// 旧来クライアント(FinalPreview.tsx)の canvas 合成をサーバへ移植したもの。
// 写真の 2:3 クロップ(zoom/offset) + フレーム + ニックネーム/days 文字を sharp で
// 原寸合成し、完成画像 JPEG を返す。文字はシステムフォント(Hiragino/Futura)を使う
// SVG テキストレイヤーを重ねる（厳密一致でなくデザイン準拠・目視調整前提）。
const os    = require('node:os');
const path  = require('node:path');
const fs    = require('node:fs');
const sharp = require('sharp');
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
const TARGET_ASPECT        = 2 / 3;

// 出力(完成画像)の最大高さ(px)。2:3 なので高さが長辺。これを超える出力は縮小する。
// 48MP 撮影では無キャップだと出力 4000×6000(=24MP)になり、1合成で写真/フレーム/合成の
// 各レイヤを 24MP ぶんネイティブ確保 → RSS が膨張する。3600(=2400×3600, 約8.6MP)に
// 抑えると印刷/DL品質は十分なまま、合成あたりのメモリを約1/3に削減できる。
// 配信画質を変える値なので調整可（小さくするほど軽い: 3000=2000×3000≒6MP 等）。
const MAX_OUTPUT_HEIGHT    = parseInt(process.env.COMPOSE_MAX_HEIGHT || '3600', 10);

// CSS の --font-heading / --font-futura に対応するシステムフォント。
const FONT_HEADING = "'Hiragino Kaku Gothic Pro', 'Hiragino Sans', sans-serif";
const FONT_FUTURA  = "'Futura', 'Century Gothic', sans-serif";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const xmlEsc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// ── 2:3 クロップ枠(出力寸法) と ソース矩形を算出（FinalPreview.tsx:116-143 移植）──
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
async function ensureRasterSource(sourcePath) {
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
        return { rasterPath: sourcePath, cleanup: false };
    }
    const tmp = path.join(os.tmpdir(), `eggcompose_${path.basename(sourcePath)}.jpg`);
    await heicToJpeg(sourcePath, tmp);
    return { rasterPath: tmp, cleanup: true };
}

// ── 最終画像を合成して JPEG バッファを返す ───────────────────────────────
// opts: { sourcePath, framePath, crop:{zoom,offsetX,offsetY}, nickname, daysText }
async function composeFinalImage({ sourcePath, framePath, crop, nickname, daysText }) {
    const { rasterPath, cleanup } = await ensureRasterSource(sourcePath);
    try {
        const meta = await sharp(rasterPath).metadata();
        const { cw, ch, extract } = computeCropGeometry(meta.width, meta.height, crop);

        // 出力解像度をキャップ(メモリ有界化)。2:3 を保ったまま長辺(高さ)を上限に収める。
        // extract は原寸座標のまま＝libvips が原寸クロップ領域を縮小出力するだけ。これにより
        // 写真/フレーム/合成の各レイヤ確保が出力寸法ぶんで済み、1合成のネイティブ確保を抑える。
        let outW = cw, outH = ch;
        if (outH > MAX_OUTPUT_HEIGHT) {
            outH = MAX_OUTPUT_HEIGHT;
            outW = Math.round(outH * TARGET_ASPECT);
        }

        // 1) 写真を 2:3 クロップ → 出力寸法へ
        const photo = await sharp(rasterPath)
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

module.exports = {
    composeFinalImage,
    makeThumbnailDataUrl,
    computeCropGeometry,
    buildTextSvg,
    DESIGN_PHOTO_W,
};
