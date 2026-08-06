// 撮影ライブビューと写真選択サムネイルで、完成画像とまったく同じ切り出しを見せるための共通ロジック。
//
// なぜ共通化するか（2026-08-05）:
//   写真選択のサムネイルは cover 中央トリミングだったため、管理画面の横シフト(offsetX)が効かず、
//   ライブビューで見えていた範囲と選んだあとの仕上がりがズレていた。基準はライブビュー側が正しい。
//
// ★元画像の向きは画面ごとに違う。ここを取り違えると画像が伸びる（2026-08-05 実際に縦伸びした）:
//   - ライブ映像(MJPEG)  … 3:4 縦（CameraController videoOutput の縦向き固定）＝ PREVIEW_ASPECT
//   - 撮影写真(/api/photos) … 4608x3456 の 4:3 横。EXIF の回転情報が無いのでブラウザも横のまま描く ＝ PHOTO_ASPECT
//   どちらも iw/ih > FINAL_ASPECT なので「縦が基準」の枝を通る点は同じ。必ず sourceAspect を渡し分けること。
//
//   ズーム倍率はカメラ側のセンサークロップで適用済み。プレビュー・写真の双方に既に効いているので
//   ここでは扱わない（サーバ合成 compose.js の computeCropGeometry も trim/offset だけを見る）。
//
// 値は必ず次と揃えること: EggCameraNode/src/compose.js の TARGET_ASPECT / TRIM_MAX_PCT、管理画面の同名定数。

export const FINAL_ASPECT = 2768 / 6000;
export const PREVIEW_ASPECT = 3 / 4;   // ライブ映像（縦）
export const PHOTO_ASPECT = 4 / 3;     // 撮影写真（横）。実値は img の naturalWidth/Height で上書きする
export const TRIM_MAX_PCT = 25;

export interface PreviewPlacement { width: string; height: string; left: string; top: string }

// サーバ合成の切り出し矩形(compose.js computeCropGeometry)と同じ式で、
// 「枠の中に切り出し範囲だけが見える」ように画像を絶対配置するCSS値を返す。
// cover+objectPosition では縦に余りが出ず縦シフトを表現できないため、絶対配置にしている。
export function computePlacement(
  trim: number, offsetX: number, offsetY: number,
  sourceAspect: number = PREVIEW_ASPECT,   // 元画像の横/縦。ライブ=3/4、撮影写真=4/3
): PreviewPlacement {
  // 比率だけで足りるので、元画像を「幅 sourceAspect × 高さ 1」として扱う
  const iw = sourceAspect, ih = 1;
  const ch = ih, cw = ch * FINAL_ASPECT;             // iw/ih > FINAL_ASPECT のため縦が基準
  const shrink = 1 - Math.min(TRIM_MAX_PCT, Math.max(0, trim)) / 100;
  const rw = cw * shrink, rh = ch * shrink;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const rx = clamp((iw - cw) / 2 + (cw - rw) / 2 + (offsetX / 100) * rw, 0, iw - rw);
  const ry = clamp((ih - ch) / 2 + (ch - rh) / 2 + (offsetY / 100) * rh, 0, ih - rh);
  return {
    width:  `${(iw / rw) * 100}%`,
    height: `${(ih / rh) * 100}%`,
    left:   `${(-rx / rw) * 100}%`,
    top:    `${(-ry / rh) * 100}%`,
  };
}

// /api/settings から crop を読んで placement を作る。失敗時は null（呼び出し側は前回値を維持）。
export async function fetchPlacement(
  sourceAspect: number = PREVIEW_ASPECT,
): Promise<PreviewPlacement | null> {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    const s = await res.json();
    return computePlacement(
      Number(s?.crop?.trim) || 0,
      Number(s?.crop?.offsetX) || 0,
      Number(s?.crop?.offsetY) || 0,
      sourceAspect,
    );
  } catch {
    return null;
  }
}
