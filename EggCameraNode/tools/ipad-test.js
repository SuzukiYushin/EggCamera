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
const os           = require('node:os');

// ── 設定 ───────────────────────────────────────────────────────────────────
const TARGET_URL     = 'http://192.168.10.104:3000/';
const SERVER_BASE    = 'http://localhost:3000';
const ADMIN_BASE     = 'http://localhost:3001';
const SCREENSHOT_DIR = path.join(__dirname, '../../data/test-screenshots');
const SCREENSHOT_KEEP = 100; // 診断スクショは新しい順にこの枚数だけ保持（無制限蓄積を防ぐ）
// Wi-Fiモード(.wda-wifi-modeフラグ)中のデフォルトは1サイクル(バッテリー温存・2026-07-12)。
// 引数/env指定があればそちらが優先。USB復旧(フラグ削除)で自動的に6へ戻る。
const CYCLES         = parseInt(process.argv[2] || process.env.CYCLES ||
    (fs.existsSync('/Users/eggcamera/EggCamera/ops/ipad/.wda-wifi-mode') ? '1' : '6'), 10);
// フォルト/スキップの途中終了サイクルは通常フローのQR待機185秒を経ず即returnするため、
// session系API(/api/sessions=60秒20回/IP=sessionLimiter)へのリクエストが密集する。連続すると
// C6等の正当サイクルが 429(too_many_requests) に巻き込まれ偽失敗する(2026-07-08 13:00枠でC4/C5
// フォルト連続→C6被弾)。本番の実客は1フロー数分で間隔十分＝この密度に達しない(実測でも実客IPの
// 429は0件)。途中終了サイクルの後に本番相当の間隔を確保し、rate-limitへ構造的に到達させない。
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.IPAD_TEST_RATE_LIMIT_COOLDOWN_MS || '30000', 10);

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

// USB切断時のWi-Fi経由テスト(2026-07-11): IPAD_TEST_WDA_URL に稼働中WDAのURL
// (例 http://127.0.0.1:18100 = launchdのAppiumはローカルネットワーク権限が無いため
// シェル権限のフォワーダ経由)を指定すると、xcodebuildによるWDA起動をスキップして
// 直接接続する。usbmuxdへのiPad登録(EnableWifiConnections=true)が別途必要。
// envが無くてもフラグファイル(.wda-wifi-mode)があれば自動適用する — post-boot検証等の
// 直接実行(node tools/ipad-test.js)でもWi-Fiモードが漏れないようにするため(2026-07-12)。
const WIFI_MODE_FLAG = '/Users/eggcamera/EggCamera/ops/ipad/.wda-wifi-mode';
const WDA_URL = process.env.IPAD_TEST_WDA_URL ||
    (fs.existsSync(WIFI_MODE_FLAG) ? 'http://127.0.0.1:18100' : null);
if (WDA_URL) {
    CAPS['appium:webDriverAgentUrl'] = WDA_URL;
    CAPS['appium:skipLogCapture']    = true;
    delete CAPS['appium:usePrebuiltWDA'];
    delete CAPS['appium:derivedDataPath'];
}

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
//
// keepaliveが落ちても即「セッション無効」と断じない。再起動直後の高負荷やトンネル張り直しで
// getUrl が一過性に無応答化することがあり（postboot 2026-06-25: C1で keepaliveが約105秒
// 無応答→旧ロジックは2連続で「セッション無効」と誤判定しC1を誤失敗計上。実際はその後復帰し
// 残りサイクルは全完走）、短い無応答で中断すると本来完了できるサイクルを取りこぼす。
// 「無応答が DEAD_AFTER_MS 連続継続」かつ「長めの確認プローブも失敗」した時だけ＝真のセッション
// 死亡とみなして中断する。一過性なら待機を完走させ、サイクルを正しく完了させる（getUrlは毎回
// withTimeoutで縛るので、判定を緩めてもC3で起きた21分ハングは再発しない）。
// セッション内で keepalive が一過性無応答に陥った回数。150s未満で復帰したブレは「失敗」計上
// しないが、慢性化（トンネルflapping等の本物の劣化）を監視が見落とさないよう、完走しても
// サマリに可視化し warn 化するための健全性カウンタ（プロセス毎=1セッション毎にリセット）。
let keepaliveBlips = 0;
async function waitWithKeepalive(browser, totalMs, intervalMs, label) {
    const deadline = Date.now() + totalMs;
    const DEAD_AFTER_MS = 150000; // これだけ連続で無応答なら（確認の上で）セッション死亡とみなす
    let downSince = 0;            // 現在の無応答ストリーク開始時刻（0=応答中）
    while (Date.now() < deadline) {
        await sleep(Math.min(intervalMs, deadline - Date.now()));
        if (Date.now() >= deadline) break;
        try {
            await withTimeout(browser.getUrl(), 20000, 'keepalive');
            if (downSince) { log(`${label} keepalive復帰（一過性の無応答だった・${Math.round((Date.now() - downSince) / 1000)}s）`); downSince = 0; }
        } catch (e) {
            if (!downSince) { downSince = Date.now(); keepaliveBlips++; } // 新しい無応答エピソードを1回計上
            const downMs = Date.now() - downSince;
            log(`${label} ⚠ keepalive無応答(${Math.round(downMs / 1000)}s継続・セッション不安定の可能性): ${e.message}`);
            if (downMs >= DEAD_AFTER_MS) {
                // 最終確認: 長めのタイムアウトで一度だけ叩く。これも落ちたら真の死亡と断定して中断
                // →フォルト→②セッション再生成へ。生きていれば誤検知なので継続する。
                const alive = await withTimeout(browser.getUrl(), 30000, 'keepalive-confirm').then(() => true).catch(() => false);
                if (alive) { log(`${label} keepalive確認プローブ成功→継続（誤検知回避）`); downSince = 0; }
                else throw new Error(`keepalive無応答が${Math.round(downMs / 1000)}s継続＋確認失敗→セッション無効と判断し中断`);
            }
        }
    }
}

// 再起動直後はシステム負荷が高く（postboot計測でloadavg 8〜10）、RemoteXPCトンネルも張りたてで、
// 最初の数十秒は getUrl が一過性に無応答化しやすい。サイクル計測を始める前に、軽量な getUrl が
// 連続で素早く返る＝トンネルが安定したことを確認してから開始する（cold-start吸収）。既に温まって
// いれば数秒で抜ける。安定しなくても maxMs で打ち切り続行する（以降は keepalive 側が監視）。
async function warmupTunnel(browser, { needOk = 3, maxMs = 90000, fastMs = 6000 } = {}) {
    const deadline = Date.now() + maxMs;
    let ok = 0;
    while (Date.now() < deadline) {
        // getUrl(WDAレベル)だけでなく execute(webview内JS実行=cold-startの真のボトルネック)も測る。
        // 旧版はgetUrlのみ温めたため、トンネルは安定でも初回サイクルの execute/sync が60sを超えて
        // C1を誤失敗させた（postboot 2026-06-27: ウォームアップ27msで通過直後にC1がexecute/sync 60s
        // timeout）。execute/sync が連続で素早く返るまでサイクルを開始しない＝C1のcold-startブレを未然に断つ。
        const t0     = Date.now();
        const urlOk  = await withTimeout(browser.getUrl(), 25000, 'warmup-url').then(() => true).catch(() => false);
        const execOk = urlOk && await withTimeout(browser.execute(() => document.readyState), 25000, 'warmup-exec')
            .then(() => true).catch(() => false);
        const dt     = Date.now() - t0;
        if (urlOk && execOk && dt <= fastMs) {
            if (++ok >= needOk) { log(`ウォームアップ完了（getUrl+execute 連続${ok}回応答・最終${dt}ms）`); return; }
        } else {
            log(`ウォームアップ: 安定待ち（url=${urlOk ? 'OK' : 'NG'} exec=${execOk ? 'OK' : 'NG'} ${dt}ms）`);
            ok = 0;
        }
        await sleep(2500);
    }
    log('⚠ ウォームアップが安定せず最大時間で続行（cold-startの可能性・keepaliveで監視継続）');
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
// 古い診断スクショを掃除し、新しい順に SCREENSHOT_KEEP 枚だけ残す。
// 順序はファイル名末尾の Date.now() で判定（stat不要・軽量）。失敗はテスト本流に波及させない。
function pruneScreenshots() {
    try {
        const files = fs.readdirSync(SCREENSHOT_DIR)
            .filter(n => n.endsWith('.png'))
            .map(n => ({ n, t: Number((n.match(/-(\d+)\.png$/) || [])[1]) || 0 }))
            .sort((a, b) => b.t - a.t);
        for (const { n } of files.slice(SCREENSHOT_KEEP)) {
            fs.rmSync(path.join(SCREENSHOT_DIR, n), { force: true });
        }
    } catch { /* 掃除失敗は無視 */ }
}

function saveScreenshot(browser, label) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    return browser.takeScreenshot().then(b64 => {
        const f = path.join(SCREENSHOT_DIR, `${label}-${Date.now()}.png`);
        fs.writeFileSync(f, Buffer.from(b64, 'base64'));
        log(`スクリーンショット: ${f}`);
        pruneScreenshots();
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
async function runCycle(browser, cycleNum, opts = {}) {
    const warmup     = opts.warmup === true; // 捨てサイクル: cold-start吸収用のカウント外クリーン周回
    const label      = warmup ? '[warmup]' : `[C${cycleNum}/${CYCLES}]`;
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

    // warmupは常にクリーン周回（フォルト/quirk/goBackなし）＝cold-start吸収に専念する。
    const plan        = warmup
        ? { faults: [], quirk: null, goBack: false, backDone: false }
        : harness.buildPlan();
    const faultLabels = plan.faults.map(f => f.label).join(' + ');
    log(warmup
        ? `${label} 計画: クリーン1周（cold-start吸収・カウント外）`
        : `${label} 計画: goBack=${plan.goBack} fault=${faultLabels || 'なし'} quirk=${plan.quirk || 'なし'}`);

    // フォルト注入（warmupはクリーン周回なので注入しない）
    if (!warmup) {
        await harness.armServerFaults(plan.faults);
        await harness.injectHookAndArm(browser, plan.faults);
    }

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

    // カメラ未接続中はシャッターボタンがdisabled化される仕様(2026-07-15)。disabled要素への
    // click()はonClickを発火しない＝空振りする。スキップ連打でCapture画面に一瞬で到達すると
    // ライブ映像<img>のonLoad(→有効化)が間に合わず「決定ボタンが出現しなかった」偽失敗になる
    // (2026-07-16判明)。実際のお客様の指もdisabledボタンは押せないので、実機と同じく
    // 有効化を待ってからクリックする(最大10秒。それでも有効化しなければ実際のバグとして
    // 従来どおり後段の決定ボタン待機タイムアウトで失敗検出される)。
    let shutterEnabled = false;
    for (let i = 0; i < 20; i++) {
        shutterEnabled = await browser.execute(() => {
            const b = document.querySelector('button');
            return !!b && !b.disabled;
        });
        if (shutterEnabled) break;
        await sleep(500);
    }
    if (!shutterEnabled) log(`${label} ⚠ シャッターボタンが10秒待っても有効化されず → そのままクリック試行`);

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
        // リロード後もCapture画面は再マウントされるため、上と同じくシャッター有効化待ちが要る。
        let reloadShutterEnabled = false;
        for (let i = 0; i < 20; i++) {
            reloadShutterEnabled = await browser.execute(() => {
                const b = document.querySelector('button');
                return !!b && !b.disabled;
            });
            if (reloadShutterEnabled) break;
            await sleep(500);
        }
        if (!reloadShutterEnabled) log(`${label} ⚠ リロード後シャッターボタンが10秒待っても有効化されず → そのままクリック試行`);
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
        // goBack(撮りなおし)は camera-screen で createSession を呼ぶ。「セッション作成API失敗」等の
        // client/expectOverlay フォルトはここに命中し、アプリは決定ボタンに進めず ErrorOverlay もしくは
        // TOP へフェイルセーフ復帰する（＝設計通りの自己復旧・本番実害なし）。決定ボタンだけを待つと
        // 30秒 timeout で誤失敗するため、他の待機ループ(決定待ち/保存後/TOP復帰時)と同様に
        // オーバーレイ／TOP復帰も fault-ok として拾う。
        // （goBack×createSessionフォルトの複合サイクルギャップ。2026-07-08 02:00枠で48h初出）
        const expectClientFault = plan.faults.some(f => f.kind === 'client' && f.expectOverlay);
        for (let i = 0; i < 6; i++) {
            await sleep(5000);
            const bs = await btns();
            if (bs.includes('決定')) { decided = true; break; }
            if (expectClientFault) {
                if (await harness.checkOverlay(browser)) {
                    log(`${label} ★ フォルト後オーバーレイ確認OK（goBack後の再セッション作成）(${faultLabels})`);
                    await testReport('info', `[iPad-TEST] ${label} フォルト検証OK(goBack後): ${faultLabels} → オーバーレイ確認`);
                    return 'fault-ok';
                }
                if (bs.includes('はじめる')) {
                    log(`${label} ★ フォルト後TOP復帰確認OK（goBack後の再セッション作成失敗→フェイルセーフ）(${faultLabels})`);
                    await testReport('info', `[iPad-TEST] ${label} フォルト検証OK(goBack後TOP復帰): ${faultLabels}`);
                    return 'fault-ok';
                }
            }
        }
        if (!decided) throw new Error('goBack後の決定ボタンが出現しなかった');
    }

    await tap('//button[text()="決定"]');
    log(`${label} 決定タップ`);

    // プレビュー(step5)で「この写真を保存する」が押下可能になるまで待つ。
    // サーバ合成フロー(serverCompose)ではプレビュー入場時にサーバ合成(数秒)が走り、
    // その間ボタンは「保存中…」で無効＝この文言は出ない。固定sleepだと合成が長引いた時に
    // 未出現タップで誤失敗するため、準備完了を待ってからタップする（旧canvasフローでは即時出現）。
    // 途中でオーバーレイ(フォルト等)が出たら後段と同じ判定に委ねる。
    let saveReady = false, overlayInPreview = false;
    for (let i = 0; i < 10; i++) {
        await sleep(2000);
        if ((await btns()).includes('この写真を保存する')) { saveReady = true; break; }
        if (await harness.checkOverlay(browser)) { overlayInPreview = true; break; }
    }
    if (overlayInPreview) {
        if (plan.faults.some(f => f.expectOverlay)) {
            log(`${label} ★ フォルト後オーバーレイ確認OK（プレビュー）(${faultLabels})`);
            await testReport('info', `[iPad-TEST] ${label} フォルト検証OK: ${faultLabels} → オーバーレイ確認`);
            return 'fault-ok';
        }
        await saveScreenshot(browser, `unexpected-overlay-preview-c${cycleNum}`);
        await testReport('alert', `▲ [iPad-TEST] ${label} 想定外オーバーレイ(プレビュー) fault=${faultLabels || 'なし'}`);
        await notifySlack(`▲ iPad Safari テスト ${label} 想定外オーバーレイ(プレビュー)`);
        throw new Error('想定外オーバーレイ（プレビュー）');
    }
    if (!saveReady) throw new Error('保存ボタンが押下可能にならなかった（プレビュー合成タイムアウト）');

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

    // warmup（捨てサイクル）はここまででcold-start吸収の役目を完了。Phase 4(DL検証/報告)は
    // 走らせない＝監視にC0の報告を出さず、カウントもしない。TOPに戻った状態でC1へ引き継ぐ。
    if (warmup) { log(`${label} cold-start吸収完了 → 本サイクルへ`); return 'completed'; }

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
    // connectionRetryTimeout=各コマンドの応答待ち上限。60sだと再起動直後の高負荷で execute/sync が
    // 一過性に超過しC1を誤失敗させた（postboot 2026-06-27）。120sへ延長して cold-start の余裕を持たせる
    // （真のハング対策は各所の withTimeout 側＝この延長では21分ハングは再発しない。newCommandTimeout=300s）。
    const opts = { hostname: '127.0.0.1', port: 4723, path: '/', protocol: 'http',
        connectionRetryTimeout: 120000, connectionRetryCount: 2, logLevel: 'error' };
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
        // cold-start吸収: 再起動直後の高負荷/張りたてトンネルが落ち着くまで待ってからサイクル開始。
        await withTimeout(warmupTunnel(browser), 100000, 'warmup-gate').catch(() => {});

        // 捨てサイクル(warmup): warmupTunnel の数秒プローブでは cold-start を取りきれない
        // （通過直後にトンネルが冷え戻り、C1のQR待機中に execute/keepalive が詰まる。postboot
        // 2026-07-01 実測: warmup 85ms通過→90s後にC1で無応答→セッション再生成再試行で回収）。
        // カウント外のクリーン1周を先に流して真の cold-start を吸収し、C1を常にクリーンにする。
        // ウォームな毎時テストには課さないよう、再起動直後(uptime小)限定で走らせる
        // （IPAD_TEST_WARMUP_CYCLE=1 で強制ON / =0 で強制OFF / 未指定は uptime で自動判定）。
        const warmupEnv     = process.env.IPAD_TEST_WARMUP_CYCLE;
        const doWarmupCycle = warmupEnv === '1' || (warmupEnv !== '0' && os.uptime() < 1800);
        if (doWarmupCycle) {
            log(`\n${'─'.repeat(40)}`);
            log(`捨てサイクル(warmup) 開始 — cold-start吸収・カウント外 (uptime=${Math.round(os.uptime())}s)`);
            try {
                await runCycle(browser, 0, { warmup: true });
            } catch (err) {
                // 捨てサイクルは失敗しても良い（185秒のQR待機を経た時点でトンネルは温まる）。C1へ進む。
                log(`捨てサイクル: 想定内エラー（warmupの役目は達成済）→続行: ${err.message}`);
            }
            // 捨てサイクルでセッションが死んだ場合は作り直してからC1へ（C1をクリーンに保つ）。
            const wAlive = await withTimeout(browser.getUrl(), 10000, 'warmup-liveness').then(() => true).catch(() => false);
            if (!wAlive) {
                log('捨てサイクル後: セッション無効 → 再生成');
                await withTimeout(browser.deleteSession(), 10000, 'warmup-del').catch(() => {});
                browser = await openSession();
                await withTimeout(browser.url(TARGET_URL), 30000, 'warmup-reopen').catch(() => {});
            }
            // 途中終了でもC1は必ずクリーンなTOPから始める。
            await withTimeout(resetPage(browser), 30000, 'warmup-reset').catch(() => {});
            log(`捨てサイクル完了 → 本サイクル開始（トンネル温め済）`);
        }

        for (let i = 0; i < CYCLES; i++) {
            log(`\n${'─'.repeat(40)}`);
            log(`サイクル ${i + 1} / ${CYCLES}`);
            // 再起動直後の初回サイクルは cold-start 高負荷で execute/sync が一過性に詰まりやすい。
            // 初回(i===0)だけは、失敗してもセッションを作り直して1回だけ再試行する。warmupの
            // execute温め＋timeout延長で大半は未然に防ぐが、最後の保険＝再起動直後のC1偽失敗を解消する。
            const maxAttempts = (i === 0) ? 2 : 1;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const result = await runCycle(browser, i + 1);
                    if (result === 'completed') stats.completed++;
                    else if (result === 'fault-ok') stats.faultOk++;
                    else if (result === 'skipped') stats.skipped++;

                    // fault-ok / skipped は途中終了なのでページをリセット
                    if (result !== 'completed') {
                        await withTimeout(resetPage(browser), 30000, 'resetPage').catch(() => {});
                        // 途中終了サイクルは185秒QR待機を経ずリクエストが密集する。次サイクルがあるなら
                        // 本番相当の間隔を空けて sessionLimiter(429) を構造的に回避する(最終サイクルは不要)。
                        if (i < CYCLES - 1 && RATE_LIMIT_COOLDOWN_MS > 0) {
                            log(`途中終了サイクル → 次サイクル前 rate-limit クールダウン ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s`);
                            await sleep(RATE_LIMIT_COOLDOWN_MS);
                        }
                    }
                    break; // このサイクルは決着
                } catch (err) {
                    const willRetry = attempt < maxAttempts;
                    log(`サイクル ${i + 1} エラー${willRetry ? '（cold-start初回・作り直して再試行）' : ''}: ${err.message}`);
                    // ③ エラー処理のコマンドもタイムアウトで縛る（死んだセッションで延々詰まらせない）
                    await withTimeout(saveScreenshot(browser, `error-c${i + 1}-a${attempt}`), 20000, 'error-screenshot').catch(() => {});
                    // ② セッション生存確認 → 死んでいたら再生成（トンネル切断で以降全滅するのを防ぐ）
                    const alive = await withTimeout(browser.getUrl(), 10000, 'liveness').then(() => true).catch(() => false);
                    if (!alive) {
                        log(`サイクル ${i + 1} 後: セッション無効 → 再生成`);
                        await testReport('warn', `[iPad-TEST] [C${i + 1}/${CYCLES}] セッション無効化(トンネル切断等)→再生成`);
                        await withTimeout(browser.deleteSession(), 10000, 'deleteSession').catch(() => {});
                        browser = await openSession();
                        await withTimeout(browser.url(TARGET_URL), 30000, 'reopen-url').catch(() => {});
                        // 再試行する初回は、作り直したセッションを再度ウォームアップしてから入る
                        if (willRetry) await withTimeout(warmupTunnel(browser, { needOk: 2, maxMs: 60000 }), 65000, 'warmup-retry').catch(() => {});
                    } else {
                        // 生きていれば従来どおりページをリセット（タイムアウト付き）
                        await withTimeout(resetPage(browser), 30000, 'resetPage').catch(() => {});
                    }
                    if (willRetry) {
                        await testReport('warn', `[iPad-TEST] [C${i + 1}/${CYCLES}] cold-start一過性失敗→再試行: ${err.message}`);
                        continue; // 初回サイクルの再試行
                    }
                    // 再試行しない／再試行も失敗 → 失敗確定
                    stats.failed++;
                    await testReport('alert', `▲ [iPad-TEST] [C${i + 1}/${CYCLES}] 失敗: ${err.message}`);
                    await notifySlack(`▲ iPad Safari テスト [C${i + 1}/${CYCLES}] 失敗: ${err.message}`);
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

    // keepaliveが一過性無応答に陥った（=完走したが不安定だった）なら、慢性化を監視が拾えるよう
    // サマリに明記し warn 化する。0なら従来どおり静か（info）。
    const blipNote = keepaliveBlips > 0 ? ` (keepalive一過性無応答${keepaliveBlips}回)` : '';
    const summary = `完了${stats.completed} フォルトOK${stats.faultOk} スキップ${stats.skipped} 失敗${stats.failed} / ${CYCLES}サイクル${blipNote}`;
    log(`\n=== セッション完了: ${summary} ===`);
    await testReport((stats.failed > 0 || keepaliveBlips > 0) ? 'warn' : 'info', `[iPad-TEST] セッション完了: ${summary}`);
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
