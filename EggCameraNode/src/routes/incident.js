'use strict';
// ユーザーUI（iPad キオスク）のローカル障害フロー用エンドポイント群（すべて :3000）。
//   GET  /api/jobs/:jobId/status   … セッション終了時にアップロード完了を判定
//   GET  /api/diagnostics          … 段階ネットワーク診断
//   POST /api/incident             … 障害の通知＋連続カウント。recover/maintain-restart を返す
//   POST /api/recovery/selftest    … 系統Aの復旧確認（撮影→合成→R2を1周。実撮影が走る）
//
// 管理API(:3001)には依存せず、ここから slack を直接呼ぶ。ローカルメンテ（その端末だけ
// メンテ画面）は mode.json(全端末ロック) とは別概念なので、ここでは mode.json を触らない。

const express = require('express');
const router = express.Router();

const { ts, IPHONE_FRAME_URL } = require('../config');
const jobsStore = require('../jobs');
const diagnostics = require('../diagnostics');
const incidentState = require('../incidentState');
const selftest = require('../selftest');
const chaos = require('../chaos');
const slack = require('../slack');

// アップロード完了判定。done なら done:true。未確定/失敗系は done:false。
router.get('/jobs/:jobId/status', (req, res) => {
    const job = jobsStore.readJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found', done: false });
    const done = job.status === 'done';
    // 完了を確認できた時点で連続カウントを切る（次セッションが「2連続」と誤判定されないように）
    if (done) incidentState.recordUploadOk(req.params.jobId);
    res.json({ status: job.status, done, attempts: job.attempts || 0 });
});

// 段階ネットワーク診断
router.get('/diagnostics', async (req, res) => {
    try {
        res.json(await diagnostics.run());
    } catch (err) {
        console.error(`[${ts()}] diagnostics error: ${err.message}`);
        res.status(500).json({ error: 'diagnostics_failed' });
    }
});

// 系統Aの軽量復旧プローブ: 実撮影をせず「カメラ(プレビュー)生存＋サーバ応答」のみ確認する。
// これが通れば客がトップからやり直せる状態に戻ったとみなす。復旧確認のために実シャッターを
// 切らない＝撮影連打/多重撮影を誘発しない。深いパイプライン検証(実撮影)は管理者selftestに委ねる。
router.get('/recovery/probe', async (req, res) => {
    const camera = await diagnostics.reachable(IPHONE_FRAME_URL, 'GET');
    res.json({ ok: !!camera.ok, camera });
});

// 障害報告（系統A: fatal / 系統B: upload-stuck）。
// レスポンスの action でフロントの次アクションを指示する:
//   recover          … 軽症。トップへ戻ってよい（画像固有/一過性）
//   maintain-restart … 重症。最終画面の後メンテ画面へ。管理画面に再起動通知済み
//   wait-network     … 回線異常。メンテ画面に留まり回線復帰を待つ
router.post('/incident', async (req, res) => {
    const { kind, detail, sessionId, jobId } = req.body || {};
    const screen = detail ? String(detail).slice(0, 300) : '';

    if (kind === 'upload-stuck') {
        const streak = incidentState.recordUploadStuck(jobId);
        const diag = await diagnostics.run().catch(() => ({ networkOk: false }));
        if (streak >= 2) {
            // 2セッション連続で未解消 → 画像固有では説明できない。再起動通知。
            slack.notify(
                `:rotating_light: アップロード未解消が${streak}セッション連続。最終画面後メンテへ移行。`
                + `要再起動の可能性（ネット:${diag.networkOk ? 'OK' : 'NG'} R2:${diag.r2 && diag.r2.ok ? 'OK' : 'NG'} Pages:${diag.pages && diag.pages.ok ? 'OK' : 'NG'}）。`,
                { level: 'alert', action: 'restart', key: 'upload-stuck-streak', throttleMs: 5 * 60_000 });
            console.log(`[${ts()}] incident upload-stuck streak=${streak} → maintain-restart`);
            return res.json({ action: 'maintain-restart', consecutive: streak, diagnostics: diag });
        }
        if (diag.networkOk) {
            // 1回目かつ回線正常 → 「画像固有」とみなしトップ復帰を許可。
            slack.notify(
                ':warning: アップロードがセッション終了までに未完了（1回目）。ネットは正常のため画像固有とみなし継続。',
                { level: 'warn', action: 'investigate', key: 'upload-stuck-once', throttleMs: 5 * 60_000 });
            return res.json({ action: 'recover', consecutive: streak, diagnostics: diag });
        }
        // 回線異常 → 復帰待ち（メンテ画面に留まる）
        slack.notify(
            `:warning: アップロード未完了＋ネットワーク異常を検知（internet:${diag.internet && diag.internet.ok ? 'OK' : 'NG'}）。回線復帰待ち。`,
            { level: 'alert', action: 'investigate', key: 'upload-stuck-net', throttleMs: 5 * 60_000 });
        return res.json({ action: 'wait-network', consecutive: streak, diagnostics: diag });
    }

    // 系統A: 即時致命エラー。メンテ画面に入ったことを通知（再起動は自動実行しない）。
    // 直近に CHAOS フォルトを注入していた＝毎時テストの想定内なら、「要調査」ではなく
    // info(対処不要) で通知する。CHAOS は本番では無効(CHAOS_ENABLED未設定)なので、実客の
    // 致命エラーは必ず従来どおり「要調査」になる（recentlyFired が常に null を返す）。
    const injected = chaos.recentlyFired();
    if (injected) {
        slack.notify(
            `:test_tube: テスト注入(${injected.target})により致命エラー → 自己復旧（想定内・テスト）。${screen ? ' 画面:' + screen : ''}`,
            { level: 'info', action: 'none', key: 'kiosk-fatal-test', throttleMs: 60_000 });
        console.log(`[${ts()}] incident fatal (test-injected ${injected.target}): ${screen} (session ${sessionId || '-'})`);
        return res.json({ action: 'recover' });
    }
    slack.notify(
        `:warning: キオスクで致命エラー → メンテ画面で自己復旧を試行中（${screen || 'no-detail'}）。`,
        { level: 'warn', action: 'investigate', key: 'kiosk-fatal', throttleMs: 60_000 });
    console.log(`[${ts()}] incident fatal: ${screen} (session ${sessionId || '-'})`);
    res.json({ action: 'recover' });
});

// 系統Aの復旧確認: 撮影→合成→R2→DL を1周（実撮影が走る）。Slackは抑制し、
// ok のときだけ「復旧」を通知する。実撮影の連打を避けるため 25秒スロットル。
let recoveryLastRunAt = 0;
router.post('/recovery/selftest', async (req, res) => {
    const now = Date.now();
    if (now - recoveryLastRunAt < 25_000) return res.json({ ok: false, skipped: true });
    recoveryLastRunAt = now;
    let r;
    try {
        r = await selftest.run({ reason: 'kiosk-recovery', notify: false });
    } catch (err) {
        console.error(`[${ts()}] recovery selftest error: ${err.message}`);
        return res.json({ ok: false, error: err.message });
    }
    if (r.ok) {
        slack.notify(':white_check_mark: キオスク自己復旧: パイプライン正常を確認、トップへ復帰します。',
            { level: 'fix', action: 'none', key: 'kiosk-recovered', throttleMs: 60_000 });
    }
    res.json(r);
});

module.exports = router;
