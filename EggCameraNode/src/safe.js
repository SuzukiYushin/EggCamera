// 障害分離の土台: 1つのルート/ジョブの例外がプロセス全体（＝撮影パス）を
// 倒さないようにする。Express5は async ルートの拒否を自動的にエラーハンドラへ
// 転送するので、最後に app.use(errorBoundary) するだけで全ルートが保護される。
const { ts } = require('./config');
const slack = require('./slack');

// 全ルート共通のエラーバウンダリ（4引数＝Expressのエラーハンドラ）。
// 例外をログ＋Slack（throttle）に残してプロセスは継続させる。不正JSON等のボディ起因
// エラーは送信元IP/UA/本文冒頭も残す（「どの投稿元の事故か」を再発時に即断するため。
// 2026-07-05 00:52の/api/test-report不正JSONは送信元不明で帰属が状況証拠止まりだった）。
function errorBoundary(err, req, res, next) { // eslint-disable-line no-unused-vars
    const bodyHead = (err && typeof err.body === 'string')
        ? ` from=${req.ip} ua="${(req.get('user-agent') || '').slice(0, 60)}" body="${err.body.slice(0, 200).replace(/\s+/g, ' ')}"`
        : '';
    console.error(`[${ts()}] [ROUTE-ERR] ${req.method} ${req.originalUrl}:${bodyHead} ${err && (err.stack || err.message)}`);
    try {
        slack.notify(`APIエラー ${req.method} ${req.path}: ${err && err.message}${bodyHead}`,
            { level: 'warn', key: `route:${req.path}`, throttleMs: 5 * 60_000 });
    } catch { /* 通知失敗は無視（本流に影響させない） */ }
    // 不正JSON等のclient起因(4xx)は400系で返す（500で数えると監視がサーバ障害と誤読する）
    const status = err && (err.statusCode || err.status) && (err.statusCode || err.status) < 500
        ? (err.statusCode || err.status) : 500;
    if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'internal_error' : 'bad_request' });
}

// バックグラウンドの定期ジョブを包む。例外/Promise拒否がトップレベルへ
// 漏れてプロセスを倒すのを防ぐ（1ジョブのバグが撮影を巻き込まない）。
function safeInterval(fn, ms, label) {
    const run = async () => {
        try { await fn(); }
        catch (e) { console.error(`[${ts()}] [JOB-ERR] ${label}: ${e && (e.stack || e.message)}`); }
    };
    return setInterval(run, ms);
}

// 単発ジョブ版。
function safeTimeout(fn, ms, label) {
    return setTimeout(async () => {
        try { await fn(); }
        catch (e) { console.error(`[${ts()}] [JOB-ERR] ${label}: ${e && (e.stack || e.message)}`); }
    }, ms);
}

module.exports = { errorBoundary, safeInterval, safeTimeout };
