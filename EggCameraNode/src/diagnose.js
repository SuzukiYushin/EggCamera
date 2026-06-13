const logger = require('./logger');

// 再起動の対象（軽い→重い順）。UIのボタンと対応。
const TARGETS = [
    { id: 'iphone',        label: 'iPhoneアプリ再起動' },
    { id: 'mac',           label: 'EggCameraMac再起動' },
    { id: 'node',          label: 'Nodeサーバ再起動' },
    { id: 'iphone-reboot', label: 'iPhone本体再起動' },
    { id: 'mac-reboot',    label: 'Mac mini本体再起動' },
];
const DEFAULT_ORDER = ['iphone', 'mac', 'node', 'iphone-reboot', 'mac-reboot'];

// 直近のログから「何を再起動すべきか」を推定する。
// 実害のあるエラーのみ対象（テスト統計・申し送り・注入フォルトは除外）。
function diagnose() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const recent = logger.getLogs(0).filter(e => new Date(e.time).getTime() >= cutoff);
    const errs = recent.filter(e =>
        !/統計:|DEPLOY-MARKER|injected_|NOTE-TO-LOOP/.test(e.text) &&
        (e.level === 'error' || /\[CLIENT|composite_failed|mac_unreachable|capture_timeout|capture_failed/.test(e.text)));

    if (!errs.length) {
        return { hasError: false, primary: null, ordered: DEFAULT_ORDER, targets: TARGETS,
                 reason: '直近10分に実害のあるエラーはありません。', recent: [] };
    }

    const text = errs.map(e => e.text).join('\n');
    let primary = null, reason = '';
    if (/mac[_-]unreachable/.test(text)) {
        primary = 'mac';
        reason = '撮影トリガがEggCameraMacに届いていません（mac_unreachable）。まずEggCameraMacの再起動を推奨。';
    } else if (/capture[_-]timeout|camera-screen|iphone_unreachable|iphone_not_found/.test(text)) {
        primary = 'iphone';
        reason = '撮影は始まるが写真が返らない/ライブ映像が来ません。iPhoneアプリの不調が濃厚。まずiPhoneアプリ再起動を推奨。';
    } else if (/uncaughtException|unhandledRejection|EADDR|listen |startup/.test(text)) {
        primary = 'node';
        reason = 'サーバ内部のエラーです。Nodeサーバの再起動を推奨。';
    } else if (/composite_failed|R2|upload/.test(text)) {
        primary = null;
        reason = 'アップロード/合成のエラーです。通信不安定が原因で後追いアップロードにより自動回復することも多いので、すぐ再起動せず様子見も可。改善しなければ下記の順で。';
    } else {
        primary = null;
        reason = 'エラーは出ていますが原因を特定できませんでした。下記の順で、必要な分だけ試してください（軽い操作から）。';
    }

    const ordered = primary ? [primary, ...DEFAULT_ORDER.filter(t => t !== primary)] : DEFAULT_ORDER;
    return {
        hasError: true, primary, ordered, targets: TARGETS, reason,
        recent: errs.slice(-8).map(e => ({ time: e.time.slice(11, 19), text: e.text.replace(/^\[[^\]]+\]\s*/, '').slice(0, 130) })),
        // 「無視」状態の同一判定に使う、エラー内容の指紋
        signature: errs.slice(-8).map(e => e.text.slice(0, 60)).join('|'),
    };
}

module.exports = { diagnose, TARGETS, DEFAULT_ORDER };
