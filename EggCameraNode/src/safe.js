// 障害分離の土台: 1つのルート/ジョブの例外がプロセス全体（＝撮影パス）を
// 倒さないようにする。Express5は async ルートの拒否を自動的にエラーハンドラへ
// 転送するので、最後に app.use(errorBoundary) するだけで全ルートが保護される。
const { ts } = require('./config');
const slack = require('./slack');

// 全ルート共通のエラーバウンダリ（4引数＝Expressのエラーハンドラ）。
// 例外を500で返し、ログ＋Slack（throttle）に残してプロセスは継続させる。
function errorBoundary(err, req, res, next) { // eslint-disable-line no-unused-vars
    console.error(`[${ts()}] [ROUTE-ERR] ${req.method} ${req.originalUrl}: ${err && (err.stack || err.message)}`);
    try {
        slack.notify(`APIエラー ${req.method} ${req.path}: ${err && err.message}`,
            { level: 'warn', key: `route:${req.path}`, throttleMs: 5 * 60_000 });
    } catch { /* 通知失敗は無視（本流に影響させない） */ }
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
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
