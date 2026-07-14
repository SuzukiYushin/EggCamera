#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────
// 成長するファミちゃん（年齢連動フレーム 9種）＋レアアイテム（2種）の画像生成。
//
// ベースは「実運用のクマ枠 photo_frameA」。frames.json の name==='photo_frameA' の実体を
// 使う（無ければ UserUI 同梱 photo_frameA.png にフォールバック）。photo_frameA は上下にクマ・
// 中央が透明（写真領域）で、数字専用の余白が無いため、写真上部に角丸バッジで数字を載せる。
// 赤ちゃんは中央に写るので、上部左寄りに置いて被りを最小化する。
//
// 合成(compose.js)は frame を fit:'fill' で出力寸法(2768×6000)に伸ばす。ここでも先に同じ寸法へ
// 整形してから焼く＝本番と同じ見た目＋出力サイズのまま（ファイルも 1〜2MB に収まる）。
//
// 出力: data/assets/frames/growth/g1..g9.png, special_a.png, special_b.png
//        data/assets/frames/growth/growthFrames.json（メタ）
//
// ※ 本番の frames.json には登録しない（= 現行稼働サーバの旧ランダム選択は拾わない）。
//    年齢連動選択は GROWTH_FRAMES=1 の時だけ有効（src/growthFrames.js）。
// ─────────────────────────────────────────────────────────────────────────
const fs   = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const FRAMES_DIR = path.resolve(__dirname, '../../data/assets/frames');
const OUT_DIR    = path.join(FRAMES_DIR, 'growth');
const META_PATH  = path.join(OUT_DIR, 'growthFrames.json');

// ベース = 実運用のクマ枠 photo_frameA を解決
function resolveBase() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, 'frames.json'), 'utf8'));
    const a = meta.find(f => f.name === 'photo_frameA');
    if (a && fs.existsSync(path.join(FRAMES_DIR, a.file))) return path.join(FRAMES_DIR, a.file);
  } catch { /* fallthrough */ }
  const bundled = path.resolve(__dirname, '../../EggCameraUserUI/src/assets/photo_frameA.png');
  if (fs.existsSync(bundled)) return bundled;
  throw new Error('photo_frameA not found (frames.json / bundled 双方)');
}

// 添付の表（各ファミちゃんレベルの days 下限＝「浅い方」）
const GROWTH = [
  { level: 1, minDays: 270, maxDays: 330  },
  { level: 2, minDays: 331, maxDays: 390  },
  { level: 3, minDays: 391, maxDays: 450  },
  { level: 4, minDays: 451, maxDays: 510  },
  { level: 5, minDays: 511, maxDays: 570  },
  { level: 6, minDays: 571, maxDays: 635  },
  { level: 7, minDays: 636, maxDays: 725  },
  { level: 8, minDays: 726, maxDays: 820  },
  { level: 9, minDays: 821, maxDays: 1000 },
];
const RARE = [
  { key: 'A', label: 'SPECIAL A' },
  { key: 'B', label: 'SPECIAL B' },
];
const RARE_PROBABILITY = 0.05; // レアが年齢フレームを差し替える確率（合計）

// 出力寸法は compose.js の TARGET_ASPECT × MAX_OUTPUT_HEIGHT と一致させる
// （iPhone 画面比で縦いっぱい = 2768×6000）。ズレると本番合成の fit:'fill' で歪む。
const W = 2768, H = 6000;
// バッジの設計値は 4000×6000 時代の実寸。横幅が変わったぶんだけ相似で縮める。
const SX = W / 4000;
// 写真領域(透明)の上部。上のクマは高さ6000換算で y≈1780 まで → その少し下・左寄りに置く。
const BADGE_CY = 2060;          // バッジ中心の縦位置（高さは変えていないのでそのまま）
const FONT = "'Futura','Century Gothic','Helvetica Neue',Arial,sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 角丸ピル＋中央寄せテキストのバッジ。cx=中心x, w/h=ピル寸法, fs=フォント。
function badgeSvg({ text, cx, w, h, fs, pillFill, pillStroke, textColor }) {
  const x = cx - w / 2, y = BADGE_CY - h / 2, rx = h / 2;
  const baseY = BADGE_CY + fs * 0.34; // alphabetic baseline を中央に合わせる
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" ` +
      `fill="${pillFill}" stroke="${pillStroke}" stroke-width="8"/>` +
    `<text x="${cx}" y="${baseY.toFixed(1)}" text-anchor="middle" font-family="${FONT}" ` +
      `font-weight="800" font-size="${fs}" letter-spacing="4" fill="${textColor}" ` +
      `xml:space="preserve">${esc(text)}</text>` +
    `</svg>`,
  );
}

async function stamp(baseResizedBuf, outFile, svgBuf) {
  await sharp(baseResizedBuf)
    .composite([{ input: svgBuf, blend: 'over' }])
    .png()
    .toFile(path.join(OUT_DIR, outFile));
}

(async () => {
  const BASE = resolveBase();
  console.log(`base: ${BASE}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 本番合成と同じく fit:'fill' で W×H に整形（歪みも取り込む）
  const baseResized = await sharp(BASE).resize(W, H, { fit: 'fill' }).png().toBuffer();

  const meta = { version: 1, base: 'photo_frameA', rareProbability: RARE_PROBABILITY, growth: [], rare: [] };

  // 成長フレーム 9種（写真上部・左寄りに赤いピルで「NNN days」）
  for (const g of GROWTH) {
    const file = `growth/g${g.level}.png`;
    const svg = badgeSvg({
      text: `${g.minDays} days`, cx: 1160 * SX, w: 1820 * SX, h: 470 * SX, fs: 232 * SX,
      pillFill: 'rgba(204,79,89,0.92)', pillStroke: 'rgba(255,255,255,0.92)', textColor: '#FFFFFF',
    });
    await stamp(baseResized, `g${g.level}.png`, svg);
    meta.growth.push({ level: g.level, minDays: g.minDays, maxDays: g.maxDays, number: g.minDays, file });
    console.log(`generated ${file}  (lv${g.level} ${g.minDays}days)`);
  }

  // レア 2種（金のピルで「SPECIAL A / B」）
  for (const r of RARE) {
    const file = `growth/special_${r.key.toLowerCase()}.png`;
    const svg = badgeSvg({
      text: r.label, cx: 1360 * SX, w: 2280 * SX, h: 470 * SX, fs: 210 * SX,
      pillFill: 'rgba(230,180,34,0.95)', pillStroke: 'rgba(255,255,255,0.95)', textColor: '#5A3E00',
    });
    await stamp(baseResized, `special_${r.key.toLowerCase()}.png`, svg);
    meta.rare.push({ key: r.key, label: r.label, file });
    console.log(`generated ${file}  (${r.label})`);
  }

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log(`\nmeta written: ${META_PATH}`);
  console.log(`growth=${meta.growth.length} rare=${meta.rare.length} rareProbability=${RARE_PROBABILITY}`);
})().catch(e => { console.error(e); process.exit(1); });
