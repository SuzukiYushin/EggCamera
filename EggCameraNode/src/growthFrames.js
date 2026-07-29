'use strict';
// ─────────────────────────────────────────────────────────────────────────
// 成長するファミちゃん（年齢連動フレーム 9種）＋レアアイテム（2種）の選択ロジック。
//
// メタは data/assets/frames/growth/growthFrames.json（tools/gen-growth-frames.js が生成）。
// これは本番の frames.json とは別管理なので、現行の旧ランダム選択(pickFrame)には一切
// 影響しない。この機能を使うのは、下の selectFrame を呼ぶブランチのコードだけ。
//
// 有効化ガード（明示オプトイン方式・既定OFF）:
//   - 環境変数 GROWTH_FRAMES === '1'（採用未定のため、明示的に有効化した時だけ動く）
//   - かつメタファイルが存在すること
// どちらか欠ければ isEnabled()=false となり、呼び出し側は従来のランダム選択へフォールバックする。
// ※ 既定OFFなので、本番へ誤ってデプロイ/リロードされても実客には影響しない。
//    デモ/検証時のみ .env に GROWTH_FRAMES=1 を置いて :3000/:3001 を再起動する。
// ─────────────────────────────────────────────────────────────────────────
const fs   = require('node:fs');
const path = require('node:path');
const { FRAMES_DIR, FRAMES_TRASH, ts } = require('./config');

const META_PATH  = path.join(FRAMES_DIR, 'growth', 'growthFrames.json');
const GROWTH_DIR = path.join(FRAMES_DIR, 'growth');
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg']);

// ── 月齢カテゴリ（クライアント指定の9区分・固定） ───────────────────────────
// 選択は満月齢（暦ベース）で行う。minMonths <= 月齢 < maxMonths が対象で、同じ区分でも
// 対象期間の実日数はお誕生日によって変わる（例: 2/28生まれの①は2/28〜4/27=59日間、
// 7/1生まれの①は7/1〜8/31=62日間）。2026-07-29 クライアント確定。
// minDays/maxDays は素材ファイル名（270days/331days/…）と対応させた表示用の目安で、
// 管理画面のプルダウン表記に使う（選択判定には使わない）。
const GROWTH_CATEGORIES = [
    { level: 1, label: '① 1ヶ月〜2ヶ月',        minMonths: 0,  maxMonths: 2,        minDays: 270, maxDays: 330 },
    { level: 2, label: '② 3ヶ月〜4ヶ月',        minMonths: 2,  maxMonths: 4,        minDays: 331, maxDays: 390 },
    { level: 3, label: '③ 5ヶ月〜6ヶ月',        minMonths: 4,  maxMonths: 6,        minDays: 391, maxDays: 450 },
    { level: 4, label: '④ 7ヶ月〜8ヶ月',        minMonths: 6,  maxMonths: 8,        minDays: 451, maxDays: 510 },
    { level: 5, label: '⑤ 9ヶ月〜10ヶ月',       minMonths: 8,  maxMonths: 10,       minDays: 511, maxDays: 570 },
    { level: 6, label: '⑥ 11ヶ月〜1歳',         minMonths: 10, maxMonths: 12,       minDays: 571, maxDays: 635 },
    { level: 7, label: '⑦ 1歳1ヶ月〜1歳3ヶ月',  minMonths: 12, maxMonths: 15,       minDays: 636, maxDays: 725 },
    { level: 8, label: '⑧ 1歳3ヶ月〜1歳半',     minMonths: 15, maxMonths: 18,       minDays: 726, maxDays: 820 },
    { level: 9, label: '⑨ 1歳半〜2歳',          minMonths: 18, maxMonths: Infinity, minDays: 821, maxDays: 1000 },
];

// レアアイテム（ランダム表示）も固定2種。管理画面はここからプルダウンで選ぶ。
const RARE_PRESETS = [
    { key: 'XB', label: 'SP-XB' },
    { key: 'XF', label: 'SP-XF' },
];

function categoryOf(level) {
    return GROWTH_CATEGORIES.find(c => c.level === Number(level)) || null;
}

function loadMeta() {
    try {
        const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
        if (!Array.isArray(meta.growth) || !meta.growth.length) return null;
        return meta;
    } catch {
        return null;
    }
}

// 管理画面の追加/削除用。loadMeta() と違い growth/rare が空でも常に有効な形を返す
// （selectFrame 等のランタイム選択ロジックはこちらを使わない＝既存挙動に影響なし）。
function loadMetaRaw() {
    try {
        const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
        if (!Array.isArray(meta.growth)) meta.growth = [];
        if (!Array.isArray(meta.rare))   meta.rare = [];
        return meta;
    } catch {
        return { version: 1, base: 'photo_frameA', rareProbability: 0.05, growth: [], rare: [] };
    }
}

function saveMeta(meta) {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

// 成長フレームを1件追加（月齢カテゴリ level を指定）。日数範囲は GROWTH_CATEGORIES から
// 決まるので手入力しない。同じカテゴリが既に登録済みなら差し替える（旧画像は .trash へ）。
function addGrowthFrame({ level }, buffer, ext) {
    if (!ALLOWED_EXT.has(ext)) throw new Error('invalid_ext');
    const cat = categoryOf(level);
    if (!cat) throw new Error('invalid_level');
    const meta = loadMetaRaw();
    fs.mkdirSync(GROWTH_DIR, { recursive: true });
    const file = `growth/g${cat.level}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(FRAMES_DIR, file), buffer);
    const entry = { level: cat.level, minDays: cat.minDays, maxDays: cat.maxDays, number: cat.minDays, file };
    const idx = meta.growth.findIndex(g => g.level === cat.level);
    if (idx === -1) {
        meta.growth.push(entry);
    } else {
        moveToTrash(meta.growth[idx].file);   // 差し替え: 旧画像は Mac mini 内に残す
        meta.growth[idx] = entry;
    }
    meta.growth.sort((a, b) => a.level - b.level);
    saveMeta(meta);
    console.log(`[${ts()}] growth frame ${idx === -1 ? 'added' : 'replaced'}: Lv${cat.level} ${cat.label} (${cat.minDays}-${cat.maxDays}days)`);
    return entry;
}

// レアアイテムを1件追加（key は RARE_PRESETS のいずれか）。同じ key は差し替える。
function addRareFrame({ key, label }, buffer, ext) {
    if (!ALLOWED_EXT.has(ext)) throw new Error('invalid_ext');
    const k = (key || '').trim();
    if (!k) throw new Error('key_required');
    const preset = RARE_PRESETS.find(r => r.key === k);
    const meta = loadMetaRaw();
    fs.mkdirSync(GROWTH_DIR, { recursive: true });
    const file = `growth/r_${k}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(FRAMES_DIR, file), buffer);
    const entry = { key: k, label: (label || '').trim() || (preset && preset.label) || k, file };
    const idx = meta.rare.findIndex(r => r.key === k);
    if (idx === -1) {
        meta.rare.push(entry);
    } else {
        moveToTrash(meta.rare[idx].file);     // 差し替え
        meta.rare[idx] = entry;
    }
    saveMeta(meta);
    console.log(`[${ts()}] rare frame ${idx === -1 ? 'added' : 'replaced'}: ${entry.label} (${k})`);
    return entry;
}

// 削除: 一覧から外すがファイルは .trash に移して Mac mini 内に残す（frames.js と同じ方針）
function deleteGrowthFrame(level) {
    const meta = loadMetaRaw();
    const idx = meta.growth.findIndex(g => g.level === Number(level));
    if (idx === -1) throw new Error('not_found');
    const [entry] = meta.growth.splice(idx, 1);
    moveToTrash(entry.file);
    saveMeta(meta);
    console.log(`[${ts()}] growth frame deleted (kept in .trash): Lv${entry.level}`);
    return entry;
}

function deleteRareFrame(key) {
    const meta = loadMetaRaw();
    const idx = meta.rare.findIndex(r => r.key === key);
    if (idx === -1) throw new Error('not_found');
    const [entry] = meta.rare.splice(idx, 1);
    moveToTrash(entry.file);
    saveMeta(meta);
    console.log(`[${ts()}] rare frame deleted (kept in .trash): ${entry.label}`);
    return entry;
}

function moveToTrash(file) {
    fs.mkdirSync(FRAMES_TRASH, { recursive: true });
    const src = path.join(FRAMES_DIR, file);
    const dst = path.join(FRAMES_TRASH, `${Date.now()}_${path.basename(file)}`);
    try { fs.renameSync(src, dst); } catch { /* ファイルが無くても一覧からは消す */ }
}

function isEnabled() {
    if (process.env.GROWTH_FRAMES !== '1') return false; // 明示オプトインのみ（既定OFF）
    return !!loadMeta();
}

// 満月齢から成長レベルを選ぶ。範囲外はクランプ（月齢不明や0ヶ月は先頭、上限超は末尾）。
// 判定は登録エントリの level に対応するカテゴリ（月齢範囲）で行う。
function pickGrowthByMonths(growth, months) {
    const sorted = [...growth].sort((a, b) => a.level - b.level);
    let chosen = sorted[0];
    for (const g of sorted) {
        const cat = categoryOf(g.level);
        if (cat && months >= cat.minMonths) chosen = g;
    }
    return chosen;
}

// 年齢連動＋低確率レアの最終選択。months は満月齢（暦ベース）。
// rng は 0..1（テスト差し込み用、既定 Math.random）。
// 戻り値: { kind, framePath, file, level?, minDays?, label?, key? } / メタ無なら null。
function selectFrame(months, rng = Math.random) {
    const meta = loadMeta();
    if (!meta) return null;

    const rareProb = typeof meta.rareProbability === 'number' ? meta.rareProbability : 0;
    if (meta.rare && meta.rare.length && rng() < rareProb) {
        const r = meta.rare[Math.floor(rng() * meta.rare.length) % meta.rare.length];
        return { kind: 'rare', key: r.key, label: r.label, file: r.file, framePath: path.join(FRAMES_DIR, r.file) };
    }

    const g = pickGrowthByMonths(meta.growth, Number(months) || 0);
    return { kind: 'growth', level: g.level, minDays: g.minDays, maxDays: g.maxDays,
             number: g.number, file: g.file, framePath: path.join(FRAMES_DIR, g.file) };
}

// 管理画面/クライアント用の一覧（url 付き）。/frames/<file> は express.static(FRAMES_DIR) で配信。
// loadMetaRaw() を使うので growth/rare の一部が空でも(追加/削除の途中でも)常に現状を返す。
function listAll() {
    const meta = loadMetaRaw();
    const withUrl = f => ({ ...f, url: `/frames/${f.file}` });
    return {
        enabled: isEnabled(),
        rareProbability: meta.rareProbability || 0,
        growth: meta.growth.map(withUrl),
        rare: meta.rare.map(withUrl),
        // 管理画面のプルダウン用（登録済みかどうかも返し、差し替えか新規かを表示できるようにする）
        categories: GROWTH_CATEGORIES.map(c => ({
            ...c, registered: meta.growth.some(g => g.level === c.level),
        })),
        rarePresets: RARE_PRESETS.map(r => ({
            ...r, registered: meta.rare.some(x => x.key === r.key),
        })),
    };
}

module.exports = {
    isEnabled, selectFrame, pickGrowthByMonths, listAll, META_PATH,
    addGrowthFrame, addRareFrame, deleteGrowthFrame, deleteRareFrame,
    GROWTH_CATEGORIES, RARE_PRESETS,
};
