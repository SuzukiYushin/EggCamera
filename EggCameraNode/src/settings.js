const fs = require('node:fs');

const { SETTINGS_PATH, ts } = require('./config');

const DEFAULTS = {
    // 撮影時センサークロップズーム(iPhone videoZoomFactor)＋合成段のpan。
    // zoom: 1.0〜（上限は端末物理上限・管理画面ゲージで無劣化範囲を可視化）
    // offsetX, offsetY: -50〜50（合成段デジタルpan、クロップ枠サイズに対する%）
    crop: { zoom: 1.0, offsetX: 0, offsetY: 0 },
    // 撮影時露出補正(iPhone exposureTargetBias)。EV単位、負=暗く/正=明るく。
    // 実際の上下限は端末側(min/maxExposureTargetBias)でもクランプされる。
    exposure: { bias: 0.0 },
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
                offsetX: clamp(raw?.crop?.offsetX, -50, 50, DEFAULTS.crop.offsetX),
                offsetY: clamp(raw?.crop?.offsetY, -50, 50, DEFAULTS.crop.offsetY),
            },
            exposure: {
                bias: clamp(raw?.exposure?.bias, -3, 3, DEFAULTS.exposure.bias),
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
            offsetX: clamp(patch?.crop?.offsetX, -50, 50, cur.crop.offsetX),
            offsetY: clamp(patch?.crop?.offsetY, -50, 50, cur.crop.offsetY),
        },
        exposure: {
            bias: clamp(patch?.exposure?.bias, -3, 3, cur.exposure.bias),
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
    console.log(`[${ts()}] settings saved: crop=${JSON.stringify(next.crop)} exposure=${JSON.stringify(next.exposure)}`);
    return next;
}

module.exports = { getSettings, saveSettings };
