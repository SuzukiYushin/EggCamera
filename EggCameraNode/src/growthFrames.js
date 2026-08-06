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
// minDays/maxDays は「生後0日 = 0」で数えた実日数（表示用の目安）。
// 以前は妊娠270日を足した 270/331/… で持っていたが、UserUI が実日数表示へ移行した
// （Birthday.tsx「270日を足す方式は廃止」）のに管理画面だけ旧起点で紛らわしかったため、
// 2026-08-05 に 0 起点へ計算し直した（各値 −270）。
// assetDays は素材ファイル名（270days/331days…）に残る旧表記。ファイルとの対応が
// 分からなくなるとフレームを入れる区分を取り違えるので、対応表としてここに残す。
const GROWTH_CATEGORIES = [
    { level: 1, label: '① 1ヶ月〜2ヶ月',        minMonths: 0,  maxMonths: 2,        minDays: 0,   maxDays: 60,  assetDays: 270 },
    { level: 2, label: '② 3ヶ月〜4ヶ月',        minMonths: 2,  maxMonths: 4,        minDays: 61,  maxDays: 120, assetDays: 331 },
    { level: 3, label: '③ 5ヶ月〜6ヶ月',        minMonths: 4,  maxMonths: 6,        minDays: 121, maxDays: 180, assetDays: 391 },
    { level: 4, label: '④ 7ヶ月〜8ヶ月',        minMonths: 6,  maxMonths: 8,        minDays: 181, maxDays: 240, assetDays: 451 },
    { level: 5, label: '⑤ 9ヶ月〜10ヶ月',       minMonths: 8,  maxMonths: 10,       minDays: 241, maxDays: 300, assetDays: 511 },
    { level: 6, label: '⑥ 11ヶ月〜1歳',         minMonths: 10, maxMonths: 12,       minDays: 301, maxDays: 365, assetDays: 571 },
    { level: 7, label: '⑦ 1歳1ヶ月〜1歳3ヶ月',  minMonths: 12, maxMonths: 15,       minDays: 366, maxDays: 455, assetDays: 636 },
    { level: 8, label: '⑧ 1歳3ヶ月〜1歳半',     minMonths: 15, maxMonths: 18,       minDays: 456, maxDays: 550, assetDays: 726 },
    { level: 9, label: '⑨ 1歳半〜2歳',          minMonths: 18, maxMonths: Infinity, minDays: 551, maxDays: 730, assetDays: 821 },
];

// レアアイテムは 2026-08-06 に「固定2種のプルダウン」をやめ、何件でも追加できる方式へ変更した。
// key は画像ファイル名にも使うため英数字のみ。管理画面からは名前(label)だけを入力させ、
// key はサーバ側で採番する（既存の XB / XF はそのまま残る）。
const RARE_KEY_SAFE = /[^A-Za-z0-9_-]/g;

function sanitizeRareKey(key) {
    return String(key || '').trim().replace(RARE_KEY_SAFE, '');
}

// 既存と衝突しない key を採番（R1, R2, …）
function newRareKey(meta) {
    const used = new Set(meta.rare.map(r => r.key));
    let n = meta.rare.length + 1;
    while (used.has(`R${n}`)) n++;
    return `R${n}`;
}

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

// レアアイテムを1件追加。key 省略時はサーバが採番するので、何件でも追加できる。
// key を明示したときだけ既存を差し替える（一覧の「差し替え」操作用）。
function addRareFrame({ key, label }, buffer, ext) {
    if (!ALLOWED_EXT.has(ext)) throw new Error('invalid_ext');
    const meta = loadMetaRaw();
    const k = sanitizeRareKey(key) || newRareKey(meta);
    fs.mkdirSync(GROWTH_DIR, { recursive: true });
    const file = `growth/r_${k}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(FRAMES_DIR, file), buffer);
    // 出現率はアイテムごとには持たない（全体率を枚数で割る方式）。
    // 追加すると1枚あたりは薄まるが、レア全体の出現率は変わらない。
    const entry = { key: k, label: String(label || '').trim() || k, file };
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

// レアの出現率は 2026-08-06 からアイテムごとに持つ。従来は全体で1つの rareProbability を
// 持ち、当たった中から等確率で1件を選んでいた。prob 未設定の既存エントリは
// 「旧・全体確率 ÷ 件数」とみなすので、移行しただけでは出方が変わらない。
// 出現率の入力を検証して 0..1 に正規化する。未指定は null を返す。
// null/undefined/'' を Number() に通すと 0 になり「0%指定」と区別できないため明示的に弾く。
function parseProb(v) {
    if (v === null || v === undefined || v === '') return null;
    const p = Number(v);
    if (!Number.isFinite(p) || p < 0 || p > 1) return null;
    return p;
}

// 出現率は「レアアイテム全体で1つ」持つ。当たったら登録アイテムから均等に選ぶので、
// 1枚あたりの出やすさは 全体率 ÷ 枚数 になる（例: 全体50%でレア10枚 → 1枚5%）。
// 枚数を足せば1枚あたりは自動的に薄まり、全体の出現率は動かない。
function rareTotalProb(meta) {
    const p = typeof meta.rareProbability === 'number' ? meta.rareProbability : 0;
    return Math.max(0, Math.min(1, p));
}

function rarePerItemProb(meta) {
    const rare = Array.isArray(meta.rare) ? meta.rare : [];
    return rare.length ? rareTotalProb(meta) / rare.length : 0;
}

// レアアイテム全体の出現率を更新（0..1）。
// 2026-08-06 に一度アイテムごとの prob を実装したが、運用意図（全体で決めて均等割り）と
// 合わなかったため全体設定へ戻した。古いデータに残る個別 prob は保存時に落とす。
function setRareProbability(prob) {
    const p = parseProb(prob);
    if (p === null) throw new Error('invalid_prob');
    const meta = loadMetaRaw();
    meta.rareProbability = p;
    for (const r of meta.rare) delete r.prob;
    saveMeta(meta);
    console.log(`[${ts()}] rare probability (total): ${(p * 100).toFixed(1)}% / ${meta.rare.length}枚 → 1枚あたり ${(rarePerItemProb(meta) * 100).toFixed(2)}%`);
    return { rareProbability: p, perItem: rarePerItemProb(meta), count: meta.rare.length };
}

// 年齢連動＋低確率レアの最終選択。months は満月齢（暦ベース）。
// rng は 0..1（テスト差し込み用、既定 Math.random）。
// 戻り値: { kind, framePath, file, level?, minDays?, label?, key? } / メタ無なら null。
function selectFrame(months, rng = Math.random) {
    const meta = loadMeta();
    if (!meta) return null;

    // まず「レアが出るか」を全体の出現率で判定し、当たったら登録アイテムから均等に1枚選ぶ。
    const rare = Array.isArray(meta.rare) ? meta.rare : [];
    if (rare.length && rng() < rareTotalProb(meta)) {
        const i = Math.min(rare.length - 1, Math.floor(rng() * rare.length));
        const r = rare[i];
        return { kind: 'rare', key: r.key, label: r.label, file: r.file,
                 framePath: path.join(FRAMES_DIR, r.file) };
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
        rareProbability: rareTotalProb(meta),   // レア全体の出現率
        rarePerItem: rarePerItemProb(meta),     // 1枚あたり（全体 ÷ 枚数）
        growth: meta.growth.map(withUrl),
        rare: meta.rare.map(withUrl),
        // 成長フレームの区分だけはプルダウンのまま（月齢の区切りは固定仕様のため）。
        // レアは固定プリセットを廃止したので rarePresets は返さない（2026-08-06）。
        categories: GROWTH_CATEGORIES.map(c => ({
            ...c, registered: meta.growth.some(g => g.level === c.level),
        })),
    };
}

module.exports = {
    isEnabled, selectFrame, pickGrowthByMonths, listAll, META_PATH,
    addGrowthFrame, addRareFrame, deleteGrowthFrame, deleteRareFrame,
    setRareProbability, GROWTH_CATEGORIES,
};
