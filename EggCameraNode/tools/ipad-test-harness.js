'use strict';
// テスト専用ハーネス。本番デプロイ時はこのファイルごと削除する。
// ipad-test.js は require に失敗するとヌルスタブに切り替わり、フォルト系は一切実行されない。

const fs   = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const FAULT_STATE = '/tmp/ipad-fault-index.json';
const HOOK_PATH   = path.join(__dirname, '../../EggCameraTestExt/hook.js');

const P_FAULT   = 0.08;
const P_QUIRK   = 0.15;
const P_GO_BACK = 0.15;

const FAULTS = [
    { id: 'session-create',   label: 'セッション作成API失敗',       kind: 'client', urlPattern: '/api/sessions$',           method: 'POST', mode: 'http500', count: 1,  expectOverlay: true              },
    { id: 'capture-502',      label: '撮影API失敗(502)',             kind: 'client', urlPattern: '/capture$',                method: 'POST', mode: 'http502', count: 1,  expectOverlay: true,  group: 'capture'   },
    { id: 'capture-server',   label: '撮影失敗(サーバ側)',           kind: 'server', target: 'capture',                                                                    expectOverlay: true,  group: 'capture'   },
    { id: 'frames-api',       label: 'フレーム一覧取得失敗',         kind: 'client', urlPattern: '/api/frames$',             method: 'GET',  mode: 'network', count: 1,  expectOverlay: false             },
    { id: 'settings-api',     label: 'クロップ設定取得失敗',         kind: 'client', urlPattern: '/api/settings$',           method: 'GET',  mode: 'network', count: 1,  expectOverlay: false             },
    { id: 'composite-upload', label: '合成画像アップロード失敗',     kind: 'client', urlPattern: '/composite$',              method: 'POST', mode: 'http500', count: 1,  expectOverlay: true,  group: 'composite' },
    { id: 'r2-server',        label: 'R2アップロード失敗',           kind: 'server', target: 'r2',                                                                         expectOverlay: false, group: 'composite' },
    { id: 'qr-server',        label: 'QR生成失敗(サーバ側)',         kind: 'server', target: 'qr',                                                                         expectOverlay: true,  group: 'composite' },
    { id: 'session-poll',     label: 'セッションポーリング持続失敗', kind: 'client', urlPattern: '/api/sessions/[0-9a-f]+$', method: 'GET',  mode: 'network', count: 25, expectOverlay: true              },
    { id: 'js-error',         label: 'フロントJS実行時エラー',       kind: 'js',                                                                                           expectOverlay: true              },
];

const QUIRKS = ['shutter-mash', 'shutter-mash', 'idle-pause', 'double-click', 'double-click', 'reload-midflow'];

const rand   = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p)   => Math.random() < p;

class TestHarness {
    constructor({ adminBase, adminToken, log }) {
        this.adminBase  = adminBase;
        this.adminToken = adminToken;
        this.log        = log || console.log;
    }

    buildPlan() {
        const plan = { faults: [], quirk: null, goBack: chance(P_GO_BACK), backDone: false };
        if (chance(P_FAULT)) {
            const idx = this._readFaultIndex();
            const picked = [];
            const usedGroups = new Set();
            const n = Math.random() < 0.03 ? 4 : Math.random() < 0.07 ? 3 : Math.random() < 0.15 ? 2 : 1;
            for (let i = 0; i < n; i++) {
                const f = FAULTS[(idx + i) % FAULTS.length];
                if (f.group && usedGroups.has(f.group)) break;
                if (f.group) usedGroups.add(f.group);
                picked.push(f);
            }
            this._saveFaultIndex((idx + picked.length) % FAULTS.length);
            plan.faults = picked;
        } else if (chance(P_QUIRK)) {
            plan.quirk = rand(QUIRKS);
        }
        return plan;
    }

    async clearServerFaults() {
        try {
            const st = await this._getJson(`${this.adminBase}/api/admin/chaos`);
            if (st.capture > 0 || st.r2 > 0 || st.qr > 0) {
                await this._delete('/api/admin/chaos');
                this.log('残留サーバフォルトを掃除');
            }
        } catch { /* 無応答は無視 */ }
    }

    // 前サイクルで装填され、自サイクル中に発火しなかったクライアント/JSフォルトを解除する。
    // 例: セッション作成フォルトは、セッションが前サイクル末に作成済みだと自サイクルで
    // 発火せず、次サイクルのセッション作成時に漏れて発火 → 想定外オーバーレイの誤検知になる。
    // clearServerFaults() のクライアント版。フックが無ければ postMessage は無害な no-op。
    async clearClientFaults(browser) {
        await browser.execute(`window.postMessage({source:'eggtest-ctl',cmd:'clear'},'*')`).catch(() => {});
    }

    async armServerFaults(faults) {
        for (const f of faults.filter(f => f.kind === 'server')) {
            await this._postJson(`${this.adminBase}/api/admin/chaos`, { target: f.target, count: 1 }).catch(() => {});
            this.log(`★ サーバフォルト注入: ${f.label}`);
        }
    }

    // faults 配列全体を受け取り、内部で client/js を振り分ける
    async injectHookAndArm(browser, faults) {
        const clientFaults = faults.filter(f => f.kind === 'client');
        const jsFault      = faults.find(f => f.kind === 'js');
        if (!clientFaults.length && !jsFault) return;

        const hookSrc = fs.readFileSync(HOOK_PATH, 'utf8');
        await browser.execute(hookSrc);

        if (clientFaults.length) {
            const faultsJson = JSON.stringify(clientFaults.map(f => ({
                id: f.id, urlPattern: f.urlPattern, method: f.method, mode: f.mode, count: f.count,
            })));
            await browser.execute(`window.postMessage({source:'eggtest-ctl',cmd:'arm',faults:${faultsJson}},'*')`);
            this.log(`★ クライアントフォルト注入: ${clientFaults.map(f => f.label).join(' + ')}`);
        }
        if (jsFault) {
            await browser.execute(`window.postMessage({source:'eggtest-ctl',cmd:'js-error',delayMs:5000},'*')`);
            this.log('★ JSエラー注入（5秒後）');
        }
    }

    async checkOverlay(browser) {
        return browser.execute(() => {
            const el = document.querySelector('[data-section="error-overlay"]');
            return el ? window.getComputedStyle(el).display !== 'none' : false;
        }).catch(() => false);
    }

    _readFaultIndex() {
        try { return JSON.parse(fs.readFileSync(FAULT_STATE, 'utf8')).index ?? 0; } catch { return 0; }
    }
    _saveFaultIndex(i) {
        fs.writeFileSync(FAULT_STATE, JSON.stringify({ index: i }));
    }
    _postJson(urlStr, body) {
        return new Promise((resolve, reject) => {
            const u    = new URL(urlStr);
            const data = JSON.stringify(body);
            const req  = http.request({
                hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Admin-Token': this.adminToken },
            }, res => { let r = ''; res.on('data', d => r += d); res.on('end', () => resolve(r)); });
            req.on('error', reject); req.write(data); req.end();
        });
    }
    _getJson(urlStr) {
        return new Promise((resolve, reject) => {
            const u = new URL(urlStr);
            http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''), headers: { 'X-Admin-Token': this.adminToken } },
                res => { let r = ''; res.on('data', d => r += d); res.on('end', () => resolve(JSON.parse(r))); }
            ).on('error', reject);
        });
    }
    _delete(urlPath) {
        return new Promise((resolve, reject) => {
            const u   = new URL(this.adminBase);
            const req = http.request({
                hostname: u.hostname, port: u.port || 80, path: urlPath, method: 'DELETE',
                headers: { 'X-Admin-Token': this.adminToken },
            }, res => { res.resume(); res.on('end', resolve); });
            req.on('error', reject); req.end();
        });
    }
}

module.exports = TestHarness;
