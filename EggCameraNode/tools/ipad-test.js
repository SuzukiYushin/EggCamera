#!/usr/bin/env node
// iPad Safari EggCamera フルフロー自動テスト
// 使い方: node EggCameraNode/tools/ipad-test.js [サイクル数(省略時6)]
// 実運用再現: 1セッション(Safari常時開放)で複数サイクルを連続実行する
// テストハーネス有効: ipad-test-harness.js が同ディレクトリに存在すること
// 本番モード: ipad-test-harness.js を削除するだけで自動的にフォルト注入なし

'use strict';

const { remote }   = require('/Users/eggcamera/ios-safari-mcp/node_modules/webdriverio');
const { execSync } = require('node:child_process');
const fs           = require('node:fs');
const path         = require('node:path');
const http         = require('node:http');

// ── 設定 ───────────────────────────────────────────────────────────────────
const TARGET_URL     = 'http://192.168.10.104:3000/';
const SERVER_BASE    = 'http://localhost:3000';
const ADMIN_BASE     = 'http://localhost:3001';
const SCREENSHOT_DIR = path.join(__dirname, '../../data/test-screenshots');
const CYCLES         = parseInt(process.argv[2] || process.env.CYCLES || '6', 10);

const CAPS = {
    platformName:                   'iOS',
    'appium:automationName':        'XCUITest',
    'appium:browserName':           'Safari',
    'appium:deviceName':            'iPad',
    'appium:udid':                  '00008132-001E2934019A401C',
    'appium:platformVersion':       '26.5',
    'appium:xcodeSigningId':        'Apple Development',
    'appium:usePrebuiltWDA':        true,
    'appium:derivedDataPath':       '/Users/eggcamera/Library/Developer/Xcode/DerivedData/WebDriverAgent-dopylywrbtefnbfmomfcvcirfvqt',
    'appium:newCommandTimeout':     300,
    'appium:webviewConnectTimeout': 30000,
    // 本番忠実性: 本番のSafariは常時開きっぱなしで再起動しない。テストも毎セッション
    // Safariを終了/再起動させず、既存のSafariへ接続する（45分毎の再起動が
    // メモリ/状態の蓄積をリセットしてリークを隠すのを防ぐ）。
    'appium:noReset':               true,
    'appium:shouldTerminateApp':    false,
    'appium:forceAppLaunch':        false,
};

function readEnv(key) {
    for (const line of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n')) {
        const m = line.match(new RegExp(`^${key}=(.+)$`));
        if (m) return m[1].trim();
    }
    return '';
}
const ADMIN_TOKEN = readEnv('ADMIN_TOKEN');
// DL検証は本番と同じ PAGES_BASE_URL(.env) を使う。旧ドメインをハードコードしない
// （Cloudflare移行で eggcamera.pages.dev → eggcamera-53k.pages.dev に変わり偽陽性DL失敗が出たため）。
const PAGES_BASE_URL = readEnv('PAGES_BASE_URL') || 'https://eggcamera-53k.pages.dev';

// ── ユーティリティ ──────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString();
const log   = (m) => console.log(`[${ts()}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Appiumコマンドのハング(WDA無応答)対策: 指定msで必ず脱出させ、例外化してフォルト扱いにする。
// （webdriverioの組込タイムアウトが効かずC3で21分ハングした事例の再発防止）
const withTimeout = (p, ms, label) => {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`タイムアウト(${ms}ms): ${label}`)), ms); });
    return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), timer]);
};
// 長い待機中もトンネル(RemoteXPC)を温め続ける。iOSはRemoteXPC無通信が数分続くとトンネルを
// アイドル切断し、実行中セッションが無効化されるため、intervalMsごとに軽量コマンドを流す。
async function waitWithKeepalive(browser, totalMs, intervalMs, label) {
    const deadline = Date.now() + totalMs;
    let consecutiveFails = 0;
    while (Date.now() < deadline) {
        await sleep(Math.min(intervalMs, deadline - Date.now()));
        if (Date.now() >= deadline) break;
        try {
            await withTimeout(browser.getUrl(), 15000, 'keepalive');
            consecutiveFails = 0;
        } catch (e) {
            consecutiveFails++;
            log(`${label} ⚠ keepalive失敗${consecutiveFails}回目(セッション不安定の可能性): ${e.message}`);
            // 連続失敗＝トンネル/セッション死亡とみなし、185秒を待たず即中断→フォルト→②セッション再生成へ。
            // （死んだセッションで残りの待機・処理を無駄に消費するのを防ぎ、復旧を早める）
            if (consecutiveFails >= 2) {
                throw new Error(`keepalive連続失敗(${consecutiveFails})→QR待機を中断(セッション無効と判断)`);
            }
        }
    }
}

function postJson(urlStr, body) {
    return new Promise((resolve, reject) => {
        const u    = new URL(urlStr);
        const data = JSON.stringify(body);
        const req  = http.request({
            hostname: u.hostname, port: u.port || 80, path: u.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
                       'X-Admin-Token': ADMIN_TOKEN },
        }, res => { let r = ''; res.on('data', d => r += d); res.on('end', () => resolve(r)); });
        req.on('error', reject); req.write(data); req.end();
    });
}
function getJson(urlStr) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),
                   headers: { 'X-Admin-Token': ADMIN_TOKEN } },
            res => { let r = ''; res.on('data', d => r += d); res.on('end', () => resolve(JSON.parse(r))); }
        ).on('error', reject);
    });
}
const notifySlack = (t, action = 'investigate') => postJson(`${ADMIN_BASE}/api/admin/notify`, { text: t, kind: 'alert', action }).catch(() => {});
const testReport  = (level, text) => postJson(`${SERVER_BASE}/api/test-report`, { level, text }).catch(() => {});
function saveScreenshot(browser, label) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    return browser.takeScreenshot().then(b64 => {
        const f = path.join(SCREENSHOT_DIR, `${label}-${Date.now()}.png`);
        fs.writeFileSync(f, Buffer.from(b64, 'base64'));
        log(`スクリーンショット: ${f}`);
    }).catch(() => {});
}

// サイクル間リセット: TOP に戻し、TOP画面が描画されるまで明示的に待つ。
// 固定sleepだとリロード未完のまま次サイクルが走り、前サイクルのエラー画面を
// 引き継いで誤検知（カスケード失敗）するため、TOP要素の出現を待ってから戻る。
// 注: session はフロントの React state のみで保持されリロードで破棄されるため、
//     localStorage 等の掃除は不要（むしろ admin-busy フラグを消す副作用がある）。
async function resetPage(browser) {
    await browser.url(TARGET_URL).catch(() => {});
    // TOP画面（日本語ボタン）が出るまで最大15秒待機。出なければログだけ残し次サイクルで再評価。
    try {
        const el = await browser.$('//button[text()="日本語"]');
        await el.waitForExist({ timeout: 15000 });
    } catch {
        log('⚠ リセット後TOP画面の確認に失敗（次サイクルで再評価）');
    }
}

// ── テストハーネス（ファイルがなければ本番モード・全スタブ） ─────────────────
const NULL_HARNESS = {
    buildPlan:         ()       => ({ faults: [], quirk: null, goBack: false, backDone: false }),
    clearServerFaults: async () => {},
    clearClientFaults: async () => {},
    armServerFaults:   async () => {},
    injectHookAndArm:  async () => {},
    checkOverlay:      async () => false,
};
let harness;
try {
    const TestHarness = require('./ipad-test-harness');
    harness = new TestHarness({ adminBase: ADMIN_BASE, adminToken: ADMIN_TOKEN, log });
    log('テストハーネス: 有効');
} catch {
    harness = NULL_HARNESS;
    log('テストハーネス: なし（本番モード・フォルト注入なし）');
}

// ── 管理ログ確認 ────────────────────────────────────────────────────────────
async function checkAdminLogs(cycleStartIso) {
    try {
        const logs   = await getJson(`${ADMIN_BASE}/api/admin/logs?lines=100`);
        const since  = new Date(cycleStartIso).getTime();
        const issues = logs
            .filter(l => new Date(l.time).getTime() >= since)
            .filter(l => /想定外|コスト警告|▲/.test(l.text) && !/iPad-TEST/.test(l.text));
        if (issues.length) {
            log(`⚠ 管理ログに要注意エントリ ${issues.length}件:`);
            issues.forEach(l => log(`  ${l.time?.slice(11, 19)} ${l.text?.slice(0, 80)}`));
            return issues.map(l => l.text?.slice(0, 80)).join(' / ');
        }
        log('管理ログ確認OK');
        return null;
    } catch (e) {
        log(`管理ログ確認失敗: ${e.message}`);
        return null;
    }
}

// ── 1サイクル ───────────────────────────────────────────────────────────────
// 戻り値: 'completed' | 'skipped' | 'fault-ok'
async function runCycle(browser, cycleNum) {
    const label      = `[C${cycleNum}/${CYCLES}]`;
    const cycleStart = ts();

    // adminBusy チェック
    const adminBusy = await browser.execute(() => localStorage.getItem('eggcamera-admin-busy'));
    if (adminBusy !== null) {
        log(`${label} 管理操作中スキップ (adminBusy=${adminBusy})`);
        return 'skipped';
    }

    await harness.clearServerFaults();
    await harness.clearClientFaults(browser); // 前サイクルの未発火クライアントフォルト漏れを防止

    // 保険: サイクル冒頭で既にエラーオーバーレイが残っているのは、前サイクル末「はじめに戻る」
    // (restart→newSession→createSession) が前サイクルのフォルトを踏んだ残留であって、本サイクルの
    // 異常ではない（ErrorOverlay は10秒で自動リロードする＝アプリは正常に自己回復する）。
    // 放置すると本サイクルの 撮影 後に「想定外オーバーレイ」として誤検知される（C4フォルト→C5カスケード）。
    // リロードで clean な TOP から開始して掃除する（サーバ側「残留サーバフォルトを掃除」と同思想）。
    if (await harness.checkOverlay(browser)) {
        log(`${label} 前サイクル末フォルトの残留オーバーレイを掃除（リロードで復帰）`);
        await withTimeout(resetPage(browser), 30000, 'reset-stale-overlay').catch(() => {});
    }

    const plan        = harness.buildPlan();
    const faultLabels = plan.faults.map(f => f.label).join(' + ');
    log(`${label} 計画: goBack=${plan.goBack} fault=${faultLabels || 'なし'} quirk=${plan.quirk || 'なし'}`);

    // フォルト注入
    await harness.armServerFaults(plan.faults);
    await harness.injectHookAndArm(browser, plan.faults);

    const tap  = async (xpath) => { const el = await browser.$(xpath); await el.click(); };
    const btns = () => browser.execute(() =>
        Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).join('|'));

    // Phase 2: フォトブースフルフロー
    await tap('//button[text()="日本語"]');
    await tap('//button[text()="はじめる"]');

    if (plan.quirk === 'idle-pause') {
        log(`${label} ◇ QUIRK: 入力画面で75秒放置`);
        await sleep(75000);
    }

    await tap('//button[text()="スキップ"]');
    await tap('//button[text()="スキップ"]');

    if (plan.quirk === 'shutter-mash') {
        log(`${label} ◇ QUIRK: 撮影ボタン連打 x6`);
        for (let i = 0; i < 6; i++) {
            await browser.execute(() => { const b = document.querySelector('button'); b?.click(); });
            await sleep(200);
        }
    } else {
        await browser.execute(() => { const b = document.querySelector('button'); b?.click(); });
    }
    log(`${label} 撮影クリック`);

    if (plan.quirk === 'reload-midflow') {
        log(`${label} ◇ QUIRK: フロー途中でリロード`);
        await sleep(3000);
        await browser.url(TARGET_URL);
        await sleep(2000);
        await tap('//button[text()="日本語"]');
        await tap('//button[text()="はじめる"]');
        await tap('//button[text()="スキップ"]');
        await tap('//button[text()="スキップ"]');
        await browser.execute(() => { const b = document.querySelector('button'); b?.click(); });
        log(`${label} リロード後: 撮影クリック`);
    }

    // 決定ボタン待機（最大30秒）
    let decided = false;
    for (let i = 0; i < 6; i++) {
        await sleep(5000);
        if ((await btns()).includes('決定')) { decided = true; break; }
        if (await harness.checkOverlay(browser)) {
            if (plan.faults.some(f => f.expectOverlay)) {
                log(`${label} ★ フォルト後オーバーレイ確認OK (${faultLabels})`);
                await testReport('info', `[iPad-TEST] ${label} フォルト検証OK: ${faultLabels} → オーバーレイ確認`);
                return 'fault-ok';
            }
            await saveScreenshot(browser, `unexpected-overlay-c${cycleNum}`);
            await testReport('alert', `▲ [iPad-TEST] ${label} 想定外オーバーレイ (fault=${faultLabels || 'なし'})`);
            await notifySlack(`▲ iPad Safari テスト ${label} 想定外オーバーレイ`);
            throw new Error('想定外オーバーレイ');
        }
    }
    if (!decided) throw new Error('決定ボタンが出現しなかった（撮影タイムアウト）');

    // goBack: 撮りなおし
    if (plan.goBack && !plan.backDone) {
        plan.backDone = true;
        log(`${label} ◇ goBack: 戻るボタンをタップ（撮りなおし）`);
        await tap('//button[text()="戻る"]');
        await sleep(1000);
        await browser.execute(() => { const b = document.querySelector('button'); b?.click(); });
        log(`${label} goBack後: 撮影クリック`);
        decided = false;
        for (let i = 0; i < 6; i++) {
            await sleep(5000);
            if ((await btns()).includes('決定')) { decided = true; break; }
        }
        if (!decided) throw new Error('goBack後の決定ボタンが出現しなかった');
    }

    await tap('//button[text()="決定"]');
    await sleep(2000); // 決定タップ後のページ遷移（→step5）を待つ
    log(`${label} 決定タップ`);

    if (plan.quirk === 'double-click') {
        log(`${label} ◇ QUIRK: 保存ボタン二度押し`);
        await tap('//button[text()="この写真を保存する"]');
        await sleep(300);
        await browser.execute(() => {
            const btns = [...document.querySelectorAll('button')];
            btns.find(b => b.textContent.includes('この写真を保存する'))?.click();
        });
    } else {
        await tap('//button[text()="この写真を保存する"]');
    }

    // 保存後: 6/7ページへの遷移をポーリング待機（最大45秒）
    let onQrPage = false;
    for (let i = 0; i < 9; i++) {
        await sleep(5000);
        if (await harness.checkOverlay(browser)) {
            if (plan.faults.some(f => f.expectOverlay)) {
                log(`${label} ★ フォルト後オーバーレイ確認OK（保存後）(${faultLabels})`);
                await testReport('info', `[iPad-TEST] ${label} フォルト検証OK: ${faultLabels} → オーバーレイ確認`);
                return 'fault-ok';
            }
            await saveScreenshot(browser, `unexpected-overlay-post-save-c${cycleNum}`);
            await testReport('alert', `▲ [iPad-TEST] ${label} 想定外オーバーレイ(保存後) fault=${faultLabels || 'なし'}`);
            await notifySlack(`▲ iPad Safari テスト ${label} 想定外オーバーレイ(保存後)`);
            throw new Error('想定外オーバーレイ（保存後）');
        }
        const on6 = await browser.execute(() => document.body.innerText.includes('6 / 7'));
        if (on6) { onQrPage = true; break; }
        log(`${label} QR遷移待機 ${(i + 1) * 5}秒…`);
    }
    if (!onQrPage) {
        const pageText = await browser.execute(() => document.body.innerText.slice(0, 80));
        throw new Error(`QR画面未到達: ${pageText}`);
    }
    log(`${label} QR画面OK`);

    // Phase 3: 3分待機（QR待ち）。単純sleepだとRemoteXPCトンネルがアイドル切断され、
    // 実行中セッションが無効化されるため、keepalive付きで待機してトンネルを維持する。
    log(`${label} Phase 3: QR待機 185秒 (keepalive 30秒間隔)`);
    await waitWithKeepalive(browser, 185000, 30000, label);

    const thanksCheck = await withTimeout(browser.execute(() =>
        document.body.innerText.includes('はじめに戻る') ? 'OK' : document.body.innerText.slice(0, 60)),
        30000, 'Thanks画面チェック(browser.execute)');
    if (thanksCheck !== 'OK') throw new Error(`Thanks画面未到達: ${thanksCheck}`);
    await tap('//button[text()="はじめに戻る"]');
    log(`${label} Thanks画面OK → TOP戻り`);

    // 「はじめに戻る」(restart) は start-screen で次セッションを作成する(newSession→createSession)。
    // 「セッション作成API失敗」等の expectOverlay クライアントフォルトは、撮影/保存では createSession を
    // 呼ばないためフロー中に発火せず、ここで初めて発火しうる。発火を放置すると ErrorOverlay が残り、
    // 次サイクル冒頭で「想定外オーバーレイ」として誤検知される（C4フォルト→C5カスケードの真因）。
    // 本サイクルのフォルト検証が成立したものとして fault-ok で確定し、次サイクルに残さない
    // （fault-ok は main 側で resetPage(リロード) され、フックごと残フォルトが破棄される）。
    if (plan.faults.some(f => f.kind === 'client' && f.expectOverlay)) {
        let trailingOverlay = false;
        for (let i = 0; i < 4; i++) { // createSession は即時。最大~8秒で十分（自動リロード10秒より前）
            if (await harness.checkOverlay(browser)) { trailingOverlay = true; break; }
            await sleep(2000);
        }
        if (trailingOverlay) {
            log(`${label} ★ フォルト後オーバーレイ確認OK（TOP復帰時のセッション再作成）(${faultLabels})`);
            await testReport('info', `[iPad-TEST] ${label} フォルト検証OK(TOP復帰時): ${faultLabels} → オーバーレイ確認`);
            return 'fault-ok';
        }
    }

    // Phase 4: DL検証 + 管理ログ確認
    const { httpCode, dlSize, qrId, hdd } = runPhase4();
    const composite  = `familia_${qrId.replace(/.*familia_/, '')}.jpg`;
    const logIssues  = await checkAdminLogs(cycleStart);
    const extras = [
        faultLabels   ? `fault=${faultLabels}` : '',
        plan.quirk    ? `quirk=${plan.quirk}`   : '',
        plan.goBack   ? 'goBack=あり'            : '',
    ].filter(Boolean).join(' ');

    if (httpCode === '200' && dlSize > 100000) {
        const msg = `[iPad-TEST] ${label} フルフロー完了 composite=${composite} DL=${Math.round(dlSize / 1024)}kB HDD=${hdd}${extras ? ' ' + extras : ''}${logIssues ? ' ⚠ログ:' + logIssues : ''}`;
        log(msg);
        await testReport(logIssues ? 'warn' : 'info', msg);
    } else {
        const msg = `▲ [iPad-TEST] ${label} DL失敗 HTTP=${httpCode} SIZE=${dlSize}`;
        log(msg);
        await testReport('alert', msg);
        await notifySlack(`▲ iPad Safari テスト ${label} DL失敗: HTTP=${httpCode} SIZE=${dlSize}`);
    }

    return 'completed';
}

// ── メイン（1セッション・複数サイクル） ────────────────────────────────────
// セッション生成（既存Safariへattach、ダメなら起動して復旧）。初回＋失敗時の再生成で共用。
async function openSession() {
    const opts = { hostname: '127.0.0.1', port: 4723, path: '/', protocol: 'http',
        connectionRetryTimeout: 60000, connectionRetryCount: 2, logLevel: 'error' };
    try {
        return await remote({ ...opts, capabilities: CAPS });
    } catch (attachErr) {
        log(`⚠ 既存Safariへの接続失敗 → 起動して復旧: ${attachErr.message}`);
        const relaunchCaps = { ...CAPS, 'appium:forceAppLaunch': true, 'appium:shouldTerminateApp': true };
        const b = await remote({ ...opts, capabilities: relaunchCaps });
        await testReport('warn', '[iPad-TEST] Safari未起動を検知し起動して復旧（再起動/クラッシュ後の想定）');
        return b;
    }
}

async function main() {
    log(`=== iPad Safari ${CYCLES}サイクルセッション開始（実運用再現: Safari常時開放）===`);

    let browser;
    const stats = { completed: 0, faultOk: 0, skipped: 0, failed: 0 };

    try {
        // 通常は既存Safariへ接続（再起動しない=本番忠実）。ただしSafariが閉じている
        // （iPad再起動後・クラッシュ後）と接続に失敗するため、その時だけ起動して復旧する。
        browser = await openSession();
        log(`セッション: ${browser.sessionId}`);
        await browser.url(TARGET_URL);

        for (let i = 0; i < CYCLES; i++) {
            log(`\n${'─'.repeat(40)}`);
            log(`サイクル ${i + 1} / ${CYCLES}`);
            try {
                const result = await runCycle(browser, i + 1);
                if (result === 'completed') stats.completed++;
                else if (result === 'fault-ok') stats.faultOk++;
                else if (result === 'skipped') stats.skipped++;

                // fault-ok / skipped は途中終了なのでページをリセット
                if (result !== 'completed') {
                    await withTimeout(resetPage(browser), 30000, 'resetPage').catch(() => {});
                }
            } catch (err) {
                stats.failed++;
                log(`サイクル ${i + 1} エラー: ${err.message}`);
                // ③ エラー処理のコマンドもタイムアウトで縛る（死んだセッションで延々詰まらせない）
                await withTimeout(saveScreenshot(browser, `error-c${i + 1}`), 20000, 'error-screenshot').catch(() => {});
                await testReport('alert', `▲ [iPad-TEST] [C${i + 1}/${CYCLES}] 失敗: ${err.message}`);
                await notifySlack(`▲ iPad Safari テスト [C${i + 1}/${CYCLES}] 失敗: ${err.message}`);
                // ② セッション生存確認 → 死んでいたら再生成（トンネル切断で以降全滅するのを防ぐ）
                const alive = await withTimeout(browser.getUrl(), 10000, 'liveness').then(() => true).catch(() => false);
                if (!alive) {
                    log(`サイクル ${i + 1} 後: セッション無効 → 再生成`);
                    await testReport('warn', `[iPad-TEST] [C${i + 1}/${CYCLES}] セッション無効化(トンネル切断等)→再生成`);
                    await withTimeout(browser.deleteSession(), 10000, 'deleteSession').catch(() => {});
                    browser = await openSession();
                    await withTimeout(browser.url(TARGET_URL), 30000, 'reopen-url').catch(() => {});
                } else {
                    // 生きていれば従来どおりページをリセット（タイムアウト付き）
                    await withTimeout(resetPage(browser), 30000, 'resetPage').catch(() => {});
                }
            }
        }

    } catch (err) {
        log(`セッション起動失敗: ${err.message}`);
        await testReport('alert', `▲ [iPad-TEST] セッション起動失敗: ${err.message}`);
        await notifySlack(`▲ iPad Safari テスト セッション起動失敗: ${err.message}`);
    } finally {
        if (browser) { await browser.deleteSession().catch(() => {}); log('セッション終了'); }
    }

    const summary = `完了${stats.completed} フォルトOK${stats.faultOk} スキップ${stats.skipped} 失敗${stats.failed} / ${CYCLES}サイクル`;
    log(`\n=== セッション完了: ${summary} ===`);
    await testReport(stats.failed > 0 ? 'warn' : 'info', `[iPad-TEST] セッション完了: ${summary}`);
}

function runPhase4() {
    const r = execSync(`
        QR_ID=$(curl -s "http://localhost:3001/api/admin/logs?lines=5" -H "X-Admin-Token: ${ADMIN_TOKEN}" \\
            | python3 -c "import sys,json; lines=[d for d in json.load(sys.stdin) if 'QR generated' in d['text']]; print(lines[-1]['text'].split('id=')[-1].strip()) if lines else print('')")
        DL=$(curl -sL -o /dev/null -w "%{http_code} %{size_download}" "${PAGES_BASE_URL}/image/\${QR_ID}.jpg")
        HDD=$(curl -s "http://localhost:3001/api/admin/disk" -H "X-Admin-Token: ${ADMIN_TOKEN}" \\
            | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\\"freeBytes\\"]//1024//1024//1024}GB')")
        echo "\$(echo \$DL | cut -d' ' -f1) \$(echo \$DL | cut -d' ' -f2) \$QR_ID \$HDD"
    `, { shell: '/bin/bash', encoding: 'utf8' }).trim();
    const [httpCode, dlSize, qrId, hdd] = r.split(' ');
    return { httpCode, dlSize: parseInt(dlSize, 10), qrId, hdd };
}

main().catch(e => { console.error(e); process.exit(1); });
