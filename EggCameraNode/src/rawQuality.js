'use strict';
// 撮影rawの解像度ガード（2026-07-04）— 12MPフォーマットrace対策の最終防衛線。
//
// Swift側(CameraController)で cold-start 時の readiness待ち＋即時リテイクを実装済みだが、
// 万一すり抜けて低解像rawが合成に混入すると「無音の品質劣化」になるため、Node側でも
// 受け取ったrawの実寸を検査する。
//   - 健全: 期待長辺 ≒ センサー長辺(8064) / crop.zoom（zoom1.34なら≈6018）
//   - 劣化: 長辺が期待の RATIO 未満（12MPビニング/raceは≈半分になる）
// 劣化時は輝度で切り分ける:
//   - 暗所 → iOSの低照度ビニング（仕様・リテイクしても12MPのまま）→ 記録のみ
//   - 明所 → race/フォーマット固着の疑い → 1回だけ自動リテイク。回収不能ならSlack alert。
// 検査・変換の失敗で撮影フローを壊さないこと（全経路 fail-open で元のrawを返す）。
//
// 無効化: .env に RAW_QUALITY_GUARD=0（デプロイ不要のロールバック手段）。
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const sharp = require('sharp');

const { ts } = require('./config');
const settings = require('./settings');
const slack = require('./slack');

const ENABLED = process.env.RAW_QUALITY_GUARD !== '0';
// iPhone 17 メインカメラ48MPの長辺。機種変更時は .env で上書き。
const SENSOR_LONG_EDGE = parseInt(process.env.RAW_SENSOR_LONG_EDGE || '8064', 10);
// 期待長辺のこの割合未満なら「劣化」（健全≈6018 と 12MP≈3009 の中間に境界を置く）
const DEGRADED_RATIO = parseFloat(process.env.RAW_DEGRADED_RATIO || '0.72');
// 平均輝度(0-255)がこれ未満なら「暗所=低照度ビニング」とみなしリテイクしない
const DARK_MEAN = parseFloat(process.env.RAW_DARK_MEAN || '70');

function execFileP(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
}

// HEIC/JPEG の実寸を sips で読む（この環境の sharp は HEIC 入力不可のため）
async function readDims(file) {
    const out = await execFileP('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const w = parseInt((out.match(/pixelWidth:\s*(\d+)/) || [])[1], 10);
    const h = parseInt((out.match(/pixelHeight:\s*(\d+)/) || [])[1], 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('dims-unreadable');
    return { width: w, height: h };
}

// 平均輝度: sips で64px縮小JPEGへ変換し sharp.stats() のRGB平均を使う
async function meanLuma(file) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eggraw-'));
    const tmpJpg = path.join(tmpDir, 'luma.jpg');
    try {
        await execFileP('sips', ['-s', 'format', 'jpeg', '-Z', '64', file, '--out', tmpJpg]);
        const stats = await sharp(tmpJpg).stats();
        const ch = stats.channels;
        return (ch[0].mean + (ch[1]?.mean ?? ch[0].mean) + (ch[2]?.mean ?? ch[0].mean)) / 3;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function expectedLongEdge() {
    const zoom = Number(settings.getSettings()?.crop?.zoom) || 1;
    return SENSOR_LONG_EDGE / Math.max(1, zoom);
}

async function assess(rawPath) {
    const { width, height } = await readDims(rawPath);
    const longEdge = Math.max(width, height);
    const expected = expectedLongEdge();
    return { width, height, longEdge, expected, degraded: longEdge < expected * DEGRADED_RATIO };
}

// 撮影rawを検査し、必要なら1回だけリテイクして最終的に使うrawのパスを返す。
//   retake: 省略可。async () => rawPath（再撮影して新しいrawパスを返す関数）
//   label:  ログ/通知の文脈（'capture' | 'test-capture' など）
async function guardRaw(rawPath, { retake = null, label = 'capture' } = {}) {
    if (!ENABLED) return rawPath;
    try {
        const a = await assess(rawPath);
        if (!a.degraded) return rawPath;

        const luma = await meanLuma(rawPath).catch(() => NaN);
        const desc = `${a.width}x${a.height} 期待長辺≈${Math.round(a.expected)} luma=${Number.isFinite(luma) ? luma.toFixed(0) : '?'}`;
        if (Number.isFinite(luma) && luma < DARK_MEAN) {
            // 暗所 → 低照度ビニング(仕様)。リテイクしても同じ結果なので受容して記録のみ。
            console.log(`[${ts()}] [rawQuality] 低解像raw(${desc}) → 暗所=低照度ビニングとして受容 (${label})`);
            return rawPath;
        }

        if (!retake) {
            console.warn(`[${ts()}] [rawQuality] 明所で低解像raw(${desc}) リテイク手段なし (${label})`);
            slack.notify(
                `撮影rawが明所なのに低解像でした(${desc}, ${label})。12MP race/フォーマット固着の疑い。` +
                `続くようなら iphone.sh run でアプリ再起動を。`,
                { level: 'alert', action: 'restart', key: 'raw-lowres', throttleMs: 10 * 60_000 });
            return rawPath;
        }

        console.warn(`[${ts()}] [rawQuality] 明所で低解像raw(${desc}) → 自動リテイク実行 (${label})`);
        const retakePath = await retake();
        const b = await assess(retakePath);
        if (!b.degraded) {
            console.log(`[${ts()}] [rawQuality] リテイクで回収 ${b.width}x${b.height} (${label})`);
            slack.notify(
                `低解像raw(${desc})を自動リテイクで回収しました(→${b.width}x${b.height}, ${label})。対処不要ですが発生は要観察。`,
                { level: 'warn', action: 'none', key: 'raw-lowres-recovered', throttleMs: 30 * 60_000 });
            return retakePath;
        }
        console.error(`[${ts()}] [rawQuality] リテイクでも低解像 ${b.width}x${b.height} (${label})`);
        slack.notify(
            `明所で低解像raw(${desc})、自動リテイクでも回復せず(${b.width}x${b.height}, ${label})。` +
            `カメラのフォーマット固着の疑い → iphone.sh run でアプリ再起動を。`,
            { level: 'alert', action: 'restart', key: 'raw-lowres-stuck', throttleMs: 10 * 60_000 });
        // 大きい方を使う（同等なら後の方＝直近の状態）
        return (b.longEdge >= a.longEdge) ? retakePath : rawPath;
    } catch (err) {
        console.warn(`[${ts()}] [rawQuality] 検査失敗(fail-open): ${err.message}`);
        return rawPath;
    }
}

module.exports = { guardRaw, assess };
