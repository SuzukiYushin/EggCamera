// 合成を独立プロセスで実行する子エントリ。compose.js の sharp/libvips のネイティブメモリを
// プロセス終了で完全解放し、親(Node本体)の RSS 高止まり(完成画像4000×6000で顕著)を防ぐ。
// stdin       : JSON { sourcePath, framePath, crop, nickname, daysText, outPath, thumbMaxSide?, dlPreviewPath?, resultPath }
// resultPath  : 結果 JSON { width, height, thumbDataUrl? } をここへ書く(stdout は使わない=汚染回避)。
const fs = require('node:fs');
const { composeFinalImage, makeThumbnailDataUrl, makeDlPreviewJpeg } = require('./compose');

async function main() {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')); // 0 = stdin
    const { buffer, width, height } = await composeFinalImage({
        sourcePath: input.sourcePath,
        framePath:  input.framePath,
        crop:       input.crop,
        nickname:   input.nickname,
        daysText:   input.daysText,
    });
    fs.writeFileSync(input.outPath, buffer);
    // DLページ先行表示用の縮小版もここ(子プロセス)で作る＝親に sharp を持ち込まない
    if (input.dlPreviewPath) {
        fs.writeFileSync(input.dlPreviewPath, await makeDlPreviewJpeg(buffer));
    }
    let thumbDataUrl;
    if (input.thumbMaxSide) thumbDataUrl = await makeThumbnailDataUrl(buffer, input.thumbMaxSide);
    // stdout は環境ツールの診断出力で汚染され得るため使わず、結果は resultPath ファイルへ書く。
    fs.writeFileSync(input.resultPath, JSON.stringify({ width, height, thumbDataUrl }));
}

main().catch(err => {
    process.stderr.write(String((err && err.stack) || err));
    process.exit(1);
});
