const fs   = require('node:fs');
const path = require('node:path');

const { COMPOSITED_DIR, CAPTURE_TIMEOUT_MS, PAGES_BASE_URL, R2_PUBLIC_BASE_URL, ts } = require('./config');
const { sendTrigger, waitForNewRawFile, ensurePreviewJpeg } = require('./capture');
const { compositeForSession, uploadToR2, generateQRDataUrl } = require('./composite');
const frames = require('./frames');
const slack  = require('./slack');

// 再起動後の自己診断: 撮影→合成→アップロード→ダウンロード確認を1周通す。
// 結果を Slack に通知して返す。実際の撮影が走るので長期テストとは同時に動かさないこと。
async function run({ reason = '' } = {}) {
    const stages = { capture: '—', composite: '—', upload: '—', verify: '—' };
    const t0 = Date.now();
    let fileName;
    try {
        // 1) 撮影
        const since = Date.now();
        await sendTrigger();
        const rawPath = await waitForNewRawFile(since, CAPTURE_TIMEOUT_MS);
        await ensurePreviewJpeg(rawPath);
        stages.capture = 'OK';

        // 2) 合成（使用中フレームから1つ）
        const active = frames.listActiveFrames();
        const frameId = active.length ? active[0].file.replace(/\.png$/i, '') : '';
        const res = await compositeForSession(rawPath, frameId, `selftest-${since}`);
        fileName = res.fileName;
        stages.composite = 'OK';

        // 3) アップロード
        await uploadToR2(path.join(COMPOSITED_DIR, fileName), fileName);
        stages.upload = 'OK';

        // 4) ダウンロード確認（Pages /image 経由 or R2 公開URL）
        const base = PAGES_BASE_URL ? `${PAGES_BASE_URL}/image/${fileName}` : `${R2_PUBLIC_BASE_URL}/${fileName}`;
        const code = await headCode(base);
        stages.verify = code === 200 ? 'OK' : `NG(${code})`;

        const ok = Object.values(stages).every(v => v === 'OK');
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const line = `撮影:${stages.capture} 合成:${stages.composite} アップ:${stages.upload} DL:${stages.verify}（${secs}s）`;
        slack.notify(`${ok ? ':white_check_mark:' : ':x:'} 再起動後セルフテスト${reason ? '（' + reason + '）' : ''}: ${line}\n`
            + (ok ? 'メンテナンス中です。問題なければ `/egg ok` でユーザー操作を再開してください。'
                  : '失敗箇所があります。`/egg logs` や `/egg status` で確認してください。`/egg ok` を送るまでロック継続。'),
            { level: ok ? 'fix' : 'alert' });
        console.log(`[${ts()}] selftest ${ok ? 'PASS' : 'FAIL'}: ${line}`);

        // テスト生成物の後始末（ローカル合成のみ。R2は保持期間で消える）
        if (fileName) fs.rm(path.join(COMPOSITED_DIR, fileName), { force: true }, () => {});
        return { ok, stages };
    } catch (err) {
        console.error(`[${ts()}] selftest error: ${err.message}`);
        slack.notify(`:x: 再起動後セルフテストが例外で失敗: ${err.message}（撮影:${stages.capture} 合成:${stages.composite} アップ:${stages.upload}）。`
            + '`/egg status` で確認してください。`/egg ok` を送るまでロック継続。',
            { level: 'alert' });
        return { ok: false, stages, error: err.message };
    }
}

function headCode(url) {
    return new Promise(resolve => {
        const lib = url.startsWith('https') ? require('node:https') : require('node:http');
        const req = lib.request(url, { method: 'GET', timeout: 8000 }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
        req.end();
    });
}

module.exports = { run };
