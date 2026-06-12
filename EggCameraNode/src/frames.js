const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const { FRAMES_DIR, FRAMES_META, FRAMES_TRASH, ts } = require('./config');

fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(FRAMES_TRASH, { recursive: true });

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg']);

// 初期シード: メタデータが無ければ UserUI 同梱の photo_frameA/B/C を取り込む
const SEED_SOURCES = ['A', 'B', 'C'].map(k => ({
    name: `フレーム ${k}`,
    src:  path.resolve(__dirname, `../../EggCameraUserUI/src/assets/photo_frame${k}.png`),
}));

function newId() {
    return crypto.randomBytes(6).toString('hex');
}

function loadMeta() {
    try {
        return JSON.parse(fs.readFileSync(FRAMES_META, 'utf8'));
    } catch {
        return null;
    }
}

function saveMeta(frames) {
    fs.writeFileSync(FRAMES_META, JSON.stringify(frames, null, 2));
}

function ensureSeeded() {
    if (loadMeta()) return;
    const frames = [];
    for (const { name, src } of SEED_SOURCES) {
        if (!fs.existsSync(src)) continue;
        const id = newId();
        const file = `${id}.png`;
        fs.copyFileSync(src, path.join(FRAMES_DIR, file));
        frames.push({ id, name, file, active: true, addedAt: Date.now() });
    }
    saveMeta(frames);
    console.log(`[${ts()}] frames seeded: ${frames.length} frame(s)`);
}

function listFrames() {
    ensureSeeded();
    return (loadMeta() || []).filter(f => fs.existsSync(path.join(FRAMES_DIR, f.file)));
}

function listActiveFrames() {
    return listFrames().filter(f => f.active);
}

function addFrameFromBuffer(buffer, name, ext) {
    if (!ALLOWED_EXT.has(ext)) throw new Error('invalid_ext');
    const frames = listFrames();
    const id = newId();
    const file = `${id}${ext}`;
    fs.writeFileSync(path.join(FRAMES_DIR, file), buffer);
    const frame = { id, name: name || `フレーム ${frames.length + 1}`, file, active: true, addedAt: Date.now() };
    frames.push(frame);
    saveMeta(frames);
    console.log(`[${ts()}] frame added: ${frame.name} (${file})`);
    return frame;
}

function addFrameFromPath(srcPath, name) {
    const ext = path.extname(srcPath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new Error('invalid_ext');
    const buffer = fs.readFileSync(srcPath);
    return addFrameFromBuffer(buffer, name || path.basename(srcPath, ext), ext);
}

// 削除: 一覧から外すがファイルは .trash に移して Mac mini 内に残す
function deleteFrame(id) {
    const frames = listFrames();
    const idx = frames.findIndex(f => f.id === id);
    if (idx === -1) throw new Error('frame_not_found');
    const [frame] = frames.splice(idx, 1);
    const src = path.join(FRAMES_DIR, frame.file);
    const dst = path.join(FRAMES_TRASH, `${Date.now()}_${frame.file}`);
    try { fs.renameSync(src, dst); } catch { /* ファイルが無くても一覧からは消す */ }
    saveMeta(frames);
    console.log(`[${ts()}] frame deleted (kept in .trash): ${frame.name}`);
    return frame;
}

function setFrameActive(id, active) {
    const frames = listFrames();
    const frame = frames.find(f => f.id === id);
    if (!frame) throw new Error('frame_not_found');
    frame.active = !!active;
    saveMeta(frames);
    console.log(`[${ts()}] frame ${active ? 'activated' : 'hidden'}: ${frame.name}`);
    return frame;
}

module.exports = {
    listFrames,
    listActiveFrames,
    addFrameFromBuffer,
    addFrameFromPath,
    deleteFrame,
    setFrameActive,
};
