#!/usr/bin/env node
// EggCamera API ソークテスト
// Chrome 拡張の代替として Node から直接 API を叩き、フル E2E サイクルを回す。
//
// 使い方:
//   node tools/api-soak.js           # 無限ループ（Ctrl+C で停止）
//   node tools/api-soak.js --once    # 1サイクルだけ実行
//
// テストするパイプライン:
//   POST /api/sessions → セッション作成
//   POST /api/sessions/:id/capture  → iPhone 撮影 (最大3回リトライ)
//   POST /api/sessions/:id/select   → 写真選択
//   POST /api/sessions/:id/composite → 合成画像アップロード → R2
//   GET  /api/sessions/:id          → 完了確認 (QR生成まで)

'use strict';
const http   = require('node:http');
const https  = require('node:https');
const fs     = require('node:fs');
const path   = require('node:path');
const { execSync } = require('node:child_process');

const BASE = 'http://localhost:3000';
const ONCE = process.argv.includes('--once');
const CAPTURE_RETRY_MAX      = 3;
const WAIT_BETWEEN_CYCLES_MS = 15_000;  // サイクル間のウェイト
const COMPOSITE_POLL_MAX_MS  = 30_000;  // composite 完了待ちタイムアウト
const IPHONE_SH = path.resolve(__dirname, '../../EggCameraIPhone/iphone.sh');
const RECOVER_SH = path.resolve(__dirname, '../../recover.sh');
let consecutiveCaptureFails = 0;
const CONSECUTIVE_FAIL_THRESHOLD = 2;  // この回数連続タイムアウトでリカバリ実行

// ── HTTP ヘルパー ─────────────────────────────────────────────────────────
function request(method, urlStr, body, contentType = 'application/json') {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const lib = url.protocol === 'https:' ? https : http;
        const opts = {
            hostname: url.hostname,
            port:     url.port,
            path:     url.pathname + url.search,
            method,
            headers:  body != null
                ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) }
                : {},
        };
        const req = lib.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`), { statusCode: res.statusCode, body: text }));
                } else {
                    try { resolve(JSON.parse(text)); } catch { resolve(text); }
                }
            });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

// ── サーバログへ出力 ─────────────────────────────────────────────────────
function serverLog(level, msg) {
    const text = `[API-SOAK] ${msg}`;
    process.stdout.write(`[${new Date().toISOString().slice(11,19)}] ${level.toUpperCase()} ${text}\n`);
    request('POST', `${BASE}/api/client-log`, JSON.stringify({ message: text }))
        .catch(() => {});
}

// ── 1x1 白 JPEG（合成画像の代替） ─────────────────────────────────────────
// サーバ側は受け取った JPEG をそのままローカル保存 + R2 アップするだけなので
// 1x1 ピクセルでも機能テストとして成立する。
const DUMMY_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
    'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
    'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
    'MjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAA' +
    'AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA' +
    'DAMBAAIRAxEAPwCwABmX/9k=',
    'base64'
);

// ── 合成画像: 実際の撮影写真を使う ─────────────────────────────────────────
async function fetchCompositeImage(photoUrl) {
    try {
        const res = await new Promise((resolve, reject) => {
            http.get(`${BASE}${photoUrl}`, resolve).on('error', reject);
        });
        const chunks = [];
        await new Promise((resolve, reject) => {
            res.on('data', c => chunks.push(c));
            res.on('end', resolve);
            res.on('error', reject);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 10_000) return { buf, ct: res.headers['content-type'] || 'image/jpeg' };
    } catch {
        // フォールバック
    }
    return { buf: DUMMY_JPEG, ct: 'image/jpeg' };
}

// ── iPhone カメラ前面確認: /api/preview/frame が ≥10KB を返すまでポーリング ──
// スクリーンが消灯したままアプリが起動されたケースを検出する。
async function waitForIphoneReady(timeoutMs = 90_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await new Promise((resolve, reject) => {
                http.get(`${BASE}/api/preview/frame`, resolve).on('error', reject);
            });
            const chunks = [];
            await new Promise((resolve, reject) => {
                res.on('data', c => chunks.push(c));
                res.on('end', resolve);
                res.on('error', reject);
            });
            const buf = Buffer.concat(chunks);
            if (res.statusCode === 200 && buf.length > 10_000) {
                serverLog('log', `iPhone カメラ前面確認 OK (${(buf.length / 1024).toFixed(0)}KB)`);
                return true;
            }
        } catch { /* retry */ }
        const elapsed = Math.round((Date.now() - start) / 1000);
        serverLog('warn', `iPhone 前面確認待ち… (${elapsed}s)`);
        await new Promise(r => setTimeout(r, 5_000));
    }
    serverLog('warn', `iPhone 前面確認タイムアウト (${timeoutMs / 1000}s) → そのまま続行`);
    return false;
}

// ── capture_timeout 時のリカバリ (iPhone 前面化 → Mac 再起動) ──────────────
async function recoverFromCaptureTimeout() {
    serverLog('warn', `capture_timeout が ${consecutiveCaptureFails} 回連続 → 自動リカバリ実行`);
    try {
        serverLog('warn', 'iPhone アプリを再起動...');
        execSync(`"${IPHONE_SH}" restart`, { timeout: 30_000, stdio: 'inherit' });

        // iPhone カメラが前面で動作するまで待つ（背面起動を検出）
        await waitForIphoneReady(90_000);

        serverLog('warn', 'Mac Swift app を再起動...');
        execSync(`launchctl kickstart -k gui/$(id -u)/com.eggcamera.mac`, { timeout: 20_000, shell: '/bin/zsh' });
        await new Promise(r => setTimeout(r, 8_000));

        consecutiveCaptureFails = 0;
        serverLog('log', 'リカバリ完了 → 次のサイクルで再試行');
    } catch (err) {
        serverLog('error', `リカバリ失敗: ${err.message}`);
    }
}

// ── 1サイクル実行 ─────────────────────────────────────────────────────────
let cycleCount = 0;
let successCount = 0;
let captureFailCount = 0;

async function runCycle() {
    cycleCount++;
    const cycleId = cycleCount;
    serverLog('log', `サイクル開始 #${cycleId}`);

    // 1. セッション作成
    const { sessionId } = await request('POST', `${BASE}/api/sessions`, JSON.stringify({}));

    // 2. 撮影（最大 CAPTURE_RETRY_MAX 回）
    let photoId, photoUrl;
    for (let attempt = 1; attempt <= CAPTURE_RETRY_MAX; attempt++) {
        try {
            const photo = await request('POST', `${BASE}/api/sessions/${sessionId}/capture`, JSON.stringify({}));
            photoId  = photo.photoId;
            photoUrl = photo.url;
            consecutiveCaptureFails = 0;
            serverLog('log', `#${cycleId} 撮影成功 shot ${attempt}/3 → ${photoId}`);
            break;
        } catch (err) {
            const code = err.statusCode;
            if (code === 504) {
                serverLog('error', `#${cycleId} capture_timeout (shot ${attempt}/${CAPTURE_RETRY_MAX})`);
                captureFailCount++;
                if (attempt === CAPTURE_RETRY_MAX) {
                    consecutiveCaptureFails++;
                    serverLog('error', `#${cycleId} 撮影全試行失敗 → サイクル中断 (連続失敗=${consecutiveCaptureFails})`);
                    return false;
                }
            } else {
                serverLog('error', `#${cycleId} 撮影エラー: ${err.message}`);
                return false;
            }
        }
    }

    // 3. 写真選択
    await request('POST', `${BASE}/api/sessions/${sessionId}/select`,
        JSON.stringify({ photoId, nickname: 'APIソーク', days: Math.floor(Math.random() * 365) + 1 }));

    // 4. 合成画像アップロード（撮影写真 or ダミー JPEG）
    const { buf: compositeImage, ct: compositeType } = await fetchCompositeImage(photoUrl);
    await request('POST', `${BASE}/api/sessions/${sessionId}/composite`, compositeImage, compositeType);
    serverLog('log', `#${cycleId} 合成アップロード送信 (${(compositeImage.length / 1024).toFixed(0)}KB)`);

    // 5. 完了確認（polling）
    const pollStart = Date.now();
    while (Date.now() - pollStart < COMPOSITE_POLL_MAX_MS) {
        await new Promise(r => setTimeout(r, 2000));
        const session = await request('GET', `${BASE}/api/sessions/${sessionId}`);
        if (session.status === 'done') {
            const { downloadUrl, deferred } = session.result || {};
            serverLog('log', `#${cycleId} 完了 QR=${downloadUrl?.slice(-30)} deferred=${deferred}`);
            successCount++;
            return true;
        }
        if (session.status === 'error') {
            serverLog('error', `#${cycleId} composite エラー: ${session.error}`);
            return false;
        }
    }
    serverLog('error', `#${cycleId} composite タイムアウト (${COMPOSITE_POLL_MAX_MS}ms)`);
    return false;
}

// ── メイン ─────────────────────────────────────────────────────────────────
async function main() {
    serverLog('log', `APIソークテスト開始 (ONCE=${ONCE})`);
    process.on('SIGINT', () => {
        serverLog('log', `停止 — サイクル=${cycleCount} 成功=${successCount} capture失敗=${captureFailCount}`);
        process.exit(0);
    });

    do {
        try {
            await runCycle();
            if (consecutiveCaptureFails >= CONSECUTIVE_FAIL_THRESHOLD) {
                await recoverFromCaptureTimeout();
            }
        } catch (err) {
            serverLog('error', `サイクル例外: ${err.message}`);
        }
        if (!ONCE) {
            serverLog('log', `サイクル=${cycleCount} 成功=${successCount} capture失敗=${captureFailCount}`);
            await new Promise(r => setTimeout(r, WAIT_BETWEEN_CYCLES_MS));
        }
    } while (!ONCE);

    serverLog('log', `終了 — サイクル=${cycleCount} 成功=${successCount}`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
