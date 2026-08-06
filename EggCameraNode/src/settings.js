const fs = require('node:fs');

const { SETTINGS_PATH, ts } = require('./config');

const DEFAULTS = {
    // 撮影時センサークロップズーム(iPhone videoZoomFactor)＋合成段のpan。
    // zoom: 1.0〜（上限は端末物理上限・管理画面ゲージで無劣化範囲を可視化）
    // offsetX, offsetY: -50〜50（合成段デジタルpan、クロップ枠サイズに対する%）
    // trim: 切り抜き(%）。完成比で切り出した枠を、さらに各辺この割合だけ内側へ詰める。
    //   0 = 従来どおり（縦は元画像の全高を使い切るため、縦シフトは動かせない）
    //   >0 にすると上下左右に余白が生まれ、その範囲で offsetX/offsetY を動かせる。
    // 上限25%: 48MP撮影ならここまでは切り出した実画素が出力(2768x6000)を上回るため、
    // 完成画像の解像度を落とさずに済む。26%以上は出力そのものが小さくなる。
    crop: { zoom: 1.0, trim: 0, offsetX: 0, offsetY: 0 },
    // 撮影時露出補正(iPhone exposureTargetBias)。EV単位、負=暗く/正=明るく。
    // 実際の上下限は端末側(min/maxExposureTargetBias)でもクランプされる。
    exposure: { bias: 0.0 },
    // 撮影画面に出す顔合わせガイド(破線の丸)の縦位置。ライブビュー枠の高さに対する%。
    // 完成画像には出ない撮影補助なので、現場で赤ちゃんの写り方に合わせて動かせるようにする。
    guide: { top: 13 },
};

function clamp(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function getSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        return {
            crop: {
                zoom:    clamp(raw?.crop?.zoom,    1, 8,  DEFAULTS.crop.zoom),
                trim:    clamp(raw?.crop?.trim,    0, 25, DEFAULTS.crop.trim),
                offsetX: clamp(raw?.crop?.offsetX, -50, 50, DEFAULTS.crop.offsetX),
                offsetY: clamp(raw?.crop?.offsetY, -50, 50, DEFAULTS.crop.offsetY),
            },
            exposure: {
                bias: clamp(raw?.exposure?.bias, -3, 3, DEFAULTS.exposure.bias),
            },
            guide: {
                top: clamp(raw?.guide?.top, 0, 90, DEFAULTS.guide.top),
            },
        };
    } catch {
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
}

function saveSettings(patch) {
    const cur = getSettings();
    const next = {
        crop: {
            zoom:    clamp(patch?.crop?.zoom,    1, 8,  cur.crop.zoom),
            trim:    clamp(patch?.crop?.trim,    0, 25, cur.crop.trim),
            offsetX: clamp(patch?.crop?.offsetX, -50, 50, cur.crop.offsetX),
            offsetY: clamp(patch?.crop?.offsetY, -50, 50, cur.crop.offsetY),
        },
        exposure: {
            bias: clamp(patch?.exposure?.bias, -3, 3, cur.exposure.bias),
        },
        guide: {
            top: clamp(patch?.guide?.top, 0, 90, cur.guide.top),
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
    console.log(`[${ts()}] settings saved: crop=${JSON.stringify(next.crop)} exposure=${JSON.stringify(next.exposure)} guide=${JSON.stringify(next.guide)}`);
    return next;
}

module.exports = { getSettings, saveSettings };
