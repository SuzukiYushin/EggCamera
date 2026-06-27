// カメラアダプタ（現行）: Mac(EggCameraMac)経由でUSB接続のiPhoneに撮影させ、
// data/raw/ に落ちた写真のパスを返す。
// interface: { name, capture(timeoutMs) -> { rawPath } }
const { sendTrigger, waitForNewRawFile } = require('../../capture');

// 1回の撮影（トリガ送信 → data/raw/ への出現待ち）。
// waitForNewRawFile は triggerId 非依存で「sinceMs 以降に現れた最初の raw」を拾うため、
// 撮影が時間的に重なると別撮影の raw を取り違える（後述の直列化で重なりを排除する）。
async function captureOnce(timeoutMs) {
    const sinceMs = Date.now();
    await sendTrigger();                                         // Node→Mac:8082→USB→iPhone
    const rawPath = await waitForNewRawFile(sinceMs, timeoutMs); // data/raw/ に出現を待つ
    return { rawPath };
}

// 物理カメラ(iPhone)は単一リソース＝撮影は必ず1件ずつしか走らない。プロセス全体で直列化する。
// sessions.js の per-session 3枚キャップはセッション内の連打(shutter-mash)を抑えるが、リロードで
// 新セッションが生まれると旧セッションの in-flight 撮影と時間的に重なり、トリガが重複発火し
// waitForNewRawFile が別撮影の raw を掴む＝「たまに4枚」多重撮影/取り違えの真因。ここで撮影窓を
// 排他化し、sendTrigger→raw取得 を不可分にすることで重なり自体を無くす。チェーンは成否に
// 関わらず継続させ、1件の失敗で後続が詰まらないようにする（各撮影は timeoutMs で必ず決着する）。
let chain = Promise.resolve();
function capture(timeoutMs) {
    const run = chain.then(() => captureOnce(timeoutMs));
    chain = run.then(() => {}, () => {}); // 次の撮影は前撮影の成否に関わらず続行
    return run;
}

module.exports = { name: 'mac-iphone', capture };
