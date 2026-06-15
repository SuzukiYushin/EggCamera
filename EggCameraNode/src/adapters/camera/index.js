// 撮影バックエンドの選択点。撮影は「トリガ→data/raw/の写真パスを返す」という
// 1点の interface に集約し、実装を差し替え可能にする（障害分離・将来の機材変更）。
//   interface: { name, capture(timeoutMs) -> { rawPath } }
// 既定は mac-iphone（現行: EggCameraMac経由のiPhone）。
// 将来 dslr.js（gphoto2で一眼テザリング撮影）を追加すれば CAMERA_ADAPTER=dslr で
// iPhoneアプリを撤去できる。
const name = process.env.CAMERA_ADAPTER || 'macIphone';

let adapter;
try {
    adapter = require(`./${name}`);
} catch {
    adapter = require('./macIphone');
}

module.exports = adapter;
