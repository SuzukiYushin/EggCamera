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

// ── 文字レイアウト（全フレーム共通・デザイン参考画像に準拠） ────────────────
// フレーム上部の帯に、ニックネームと日数を中央揃えで置く。位置・サイズはすべて
// 出力幅 cw に対する比率で持つ（アスペクトは TARGET_ASPECT 固定なので高さ基準と等価。
// 出力解像度を変えてもレイアウトが崩れない）。フレーム9種＋レアで共通の位置。
// ※微調整はこの比率だけを触ればよい（TUNABLE）。
const NAME_BASELINE_RATIO  = 0.182;   // ニックネームのベースライン(cw基準)
const DAYS_BASELINE_RATIO  = 0.261;   // 日数のベースライン(cw基準)
const NICKNAME_FONT_RATIO  = 0.069;   // ニックネームの文字サイズ(cw基準)
const DAYS_FONT_RATIO      = 0.050;   // 日数の文字サイズ(cw基準)
const NICKNAME_TRACKING_EM = 0.05;    // 字間(em)
const DAYS_TRACKING_EM     = 0.03;
const DAYS_LINE_HEIGHT     = 1.25;    // 日数が複数行になった場合の行送り
const TEXT_COLOR           = '#8A8A8A'; // TUNABLE: デザイン指定のグレー
// 完成画像のアスペクト。iPhone の画面比(1179:2556 ≒ 19.5:9)で縦いっぱいに切る＝
// スマホの壁紙/全画面表示で余白なく収まる。高さ 6000 なら 2768×6000。
// 旧値は 2/3(=4000×6000)。変更時は成長フレーム(gen-growth-frames.js)と
// UI プレビュー(FinalPreviewServer/FinalPreview)のアスペクトも合わせること。
const TARGET_ASPECT        = 2768 / 6000;

// 切り抜き(trim)の上限%。48MP撮影ならここまでは切り出した実画素が出力寸法を上回るので、
// 完成画像の解像度を落とさずに位置調整できる。管理画面・UserUI側の上限とも揃えること。
const TRIM_MAX_PCT = 25;

// 出力(完成画像)の最大高さ(px)。縦長なので高さが長辺。これを超える出力は縮小する。
// 無キャップだと 48MP 撮影の原寸クロップがそのまま出力寸法になり、1合成で写真/フレーム/合成の
// 各レイヤをそのぶんネイティブ確保 → RSS が膨張する。現行は 6000(=2768×6000, 約16.6MP)。
// 配信画質を変える値なので調整可（小さくするほど軽い: 3600=1661×3600≒6MP 等）。
const MAX_OUTPUT_HEIGHT    = parseInt(process.env.COMPOSE_MAX_HEIGHT || '3600', 10);

// デザインの幾何学サンセリフ（Futura系）。日本語のニックネームも入りうるので、
// 欧文は Futura、日本語は Hiragino へフォールバックする並びにする。
const FONT_NAME   = "'Futura', 'Century Gothic', 'Hiragino Kaku Gothic Pro', 'Hiragino Sans', sans-serif";
const FONT_FUTURA = "'Futura', 'Century Gothic', sans-serif";

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
    // trim(%): 切り出し枠を各辺この割合だけ内側へ詰める。完成画像の比は保ったまま
    // 範囲が小さくなるので、その差分が offsetX/offsetY の可動域になる。
    // trim=0 だと縦は元画像の全高を使い切り、offsetY はクランプされて必ず 0 になる。
    const trim = Math.min(TRIM_MAX_PCT, Math.max(0, Number(crop?.trim) || 0));
    const shrink = 1 - trim / 100;
    const offX = crop?.offsetX || 0;
    const offY = crop?.offsetY || 0;
    const rw = cw * shrink / zoom;
    const rh = ch * shrink / zoom;
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

// ── 文字レイヤー(SVG) を作る。中央揃えでフレーム上部の帯に載せる ──────────
function buildTextSvg(cw, ch, nickname, daysText) {
    const x = cw / 2;
    const parts = [];

    // ベースライン指定（dominant-baseline は使わない）＋中央揃え。letter-spacing は
    // 末尾の1文字ぶんも右に足されるため、その半分を左へ戻して見た目の中心を合わせる。
    const textEl = (str, baseline, fontSize, family, weight, trackingEm) => {
        const tracking = trackingEm * fontSize;
        return (
            `<text x="${(x - tracking / 2).toFixed(1)}" y="${baseline.toFixed(1)}" ` +
            `font-family="${family}" font-weight="${weight}" ` +
            `font-size="${fontSize.toFixed(1)}" letter-spacing="${tracking.toFixed(2)}" ` +
            `text-anchor="middle" fill="${TEXT_COLOR}" xml:space="preserve">${xmlEsc(str)}</text>`
        );
    };

    if (nickname) {
        parts.push(textEl(nickname, cw * NAME_BASELINE_RATIO, cw * NICKNAME_FONT_RATIO,
                          FONT_NAME, 700, NICKNAME_TRACKING_EM));
    }
    if (daysText) {
        const fs = cw * DAYS_FONT_RATIO;
        let y = cw * DAYS_BASELINE_RATIO;
        for (const line of String(daysText).split('\n')) {
            parts.push(textEl(line, y, fs, FONT_FUTURA, 700, DAYS_TRACKING_EM));
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
        // 上限は「実際に切り出した画素数」。切り抜き(trim)を強めると切り出しが小さくなるので、
        // 切り抜き前の枠(ch)を基準にすると拡大＝偽の解像度を作ってしまう（trim 26%以上で発生）。
        // 実画素を超えない範囲で MAX_OUTPUT_HEIGHT に収める＝縮小のみ行う。
        let outH = Math.min(extract.height, MAX_OUTPUT_HEIGHT);
        let outW = Math.round(outH * TARGET_ASPECT);

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
};
