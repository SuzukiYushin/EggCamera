'use strict';
// 段階ネットワーク診断。アップロードが詰まった/致命エラーが出たとき、
// 「どの区間で切れているか」を切り分ける。フロント→サーバ(:3000)の疎通は
// このAPIが応答している時点で自明なので、サーバから外向きの各区間を確認する:
//   server   … このプロセス自身（常に ok）
//   r2       … R2 公開オリジン（R2_PUBLIC_BASE_URL）への到達
//   pages    … Cloudflare Pages（PAGES_BASE_URL）への到達 = ダウンロードページ
//   internet … 外部インターネット（Cloudflare）への到達
//
// 各区間は HEAD/GET で軽く叩き、何らかのHTTPステータスが返れば「到達OK」とみなす
// （4xx でも経路は生きている）。接続失敗/タイムアウトのみ ng。

const { R2_PUBLIC_BASE_URL, PAGES_BASE_URL, ts } = require('./config');

const PROBE_TIMEOUT_MS = 6000;
const INTERNET_PROBE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

// URL へ到達できるか（到達=何らかのHTTPステータスが返る）。接続失敗/タイムアウトは ok:false。
function reachable(url, method = 'HEAD') {
    return new Promise(resolve => {
        let lib;
        try { lib = url.startsWith('https') ? require('node:https') : require('node:http'); }
        catch { return resolve({ ok: false, detail: 'bad-url' }); }
        let req;
        try {
            req = lib.request(url, { method, timeout: PROBE_TIMEOUT_MS }, res => {
                res.resume();
                resolve({ ok: true, code: res.statusCode });
            });
        } catch (e) { return resolve({ ok: false, detail: e.message }); }
        req.on('error', e => resolve({ ok: false, detail: e.code || e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'timeout' }); });
        req.end();
    });
}

// 段階診断を実行。internet→pages→r2 の順で外側から見て、結果オブジェクトを返す。
async function run() {
    const result = {
        server: { ok: true },
        internet: { ok: false },
        pages: { ok: false },
        r2: { ok: false },
        ts: ts(),
    };

    // 外部到達（trace は HEAD 非対応のことがあるため GET）
    result.internet = await reachable(INTERNET_PROBE_URL, 'GET');

    // Pages（ダウンロードページ配信元）
    result.pages = PAGES_BASE_URL
        ? await reachable(PAGES_BASE_URL, 'HEAD')
        : { ok: false, detail: 'not-configured' };

    // R2 公開オリジン
    result.r2 = R2_PUBLIC_BASE_URL
        ? await reachable(R2_PUBLIC_BASE_URL, 'HEAD')
        : { ok: false, detail: 'not-configured' };

    // 総合判定: 外部に出られていれば「回線は正常」とみなす（R2/Pages が一時404や未設定でも、
    // internet が通れば回線は生きている＝アップロード失敗は画像/サーバ固有の可能性が高い）。
    result.networkOk = !!result.internet.ok;
    return result;
}

module.exports = { run, reachable };
