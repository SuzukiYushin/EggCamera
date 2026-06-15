// カメラアダプタ（現行）: Mac(EggCameraMac)経由でUSB接続のiPhoneに撮影させ、
// data/raw/ に落ちた写真のパスを返す。
// interface: { name, capture(timeoutMs) -> { rawPath } }
const { sendTrigger, waitForNewRawFile } = require('../../capture');

async function capture(timeoutMs) {
    const sinceMs = Date.now();
    await sendTrigger();                                   // Node→Mac:8082→USB→iPhone
    const rawPath = await waitForNewRawFile(sinceMs, timeoutMs); // data/raw/ に出現を待つ
    return { rawPath };
}

module.exports = { name: 'mac-iphone', capture };
