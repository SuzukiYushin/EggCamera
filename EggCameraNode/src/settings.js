const fs = require('node:fs');

const { SETTINGS_PATH, ts } = require('./config');

const DEFAULTS = {
    // 撮影画像のクロップ調整（FinalPreview の canvas 合成時に適用）
    // zoom: 1.0〜3.0（拡大率） / offsetX, offsetY: -50〜50（クロップ枠サイズに対する%）
    crop: { zoom: 1.0, offsetX: 0, offsetY: 0 },
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
                zoom:    clamp(raw?.crop?.zoom,    1, 3,  DEFAULTS.crop.zoom),
                offsetX: clamp(raw?.crop?.offsetX, -50, 50, DEFAULTS.crop.offsetX),
                offsetY: clamp(raw?.crop?.offsetY, -50, 50, DEFAULTS.crop.offsetY),
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
            zoom:    clamp(patch?.crop?.zoom,    1, 3,  cur.crop.zoom),
            offsetX: clamp(patch?.crop?.offsetX, -50, 50, cur.crop.offsetX),
            offsetY: clamp(patch?.crop?.offsetY, -50, 50, cur.crop.offsetY),
        },
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
    console.log(`[${ts()}] settings saved: crop=${JSON.stringify(next.crop)}`);
    return next;
}

module.exports = { getSettings, saveSettings };
