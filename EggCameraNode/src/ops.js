const { execFile } = require('node:child_process');
const path = require('node:path');

const { ts, IPHONE_FRAME_URL } = require('./config');
const mode = require('./mode');
const selftest = require('./selftest');

const UID = process.getuid ? process.getuid() : 0;
const IPHONE_DIR = path.resolve(__dirname, '../../EggCameraIPhone');
const IPHONE_FRAME = IPHONE_FRAME_URL; // USB(iproxy)経由の 127.0.0.1:8080/frame（config一元）

function sh(cmd, args, opts = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: 300_000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '') + (stderr || '') });
        });
    });
}
function marker(text) { console.log(`[${ts()}] DEPLOY-MARKER(admin-restart): ${text}`); }
const wait = ms => new Promise(r => setTimeout(r, ms));
async function httpCode(url) {
    const r = await sh('curl', ['-s', '-o', '/dev/null', '-m', '5', '-w', '%{http_code}', url]);
    return r.out.trim();
}
function kickstart(label) { return sh('launchctl', ['kickstart', '-k', `gui/${UID}/${label}`]); }

// 対象を再起動。node/mac-reboot は自プロセス/ホストが落ちるので即時応答系。
// 戻り値 { immediate, message }。immediate=true は「これから落ちる/数分かかる」系。
async function restart(target) {
    switch (target) {
        case 'node': {
            mode.startMaintenance({ reason: '管理画面: node再起動', runSelfTestOnBoot: true });
            marker('管理画面からnodeサーバを再起動。ロック後、起動時に自己診断を実行。');
            setTimeout(() => kickstart('com.eggcamera.node'), 600);
            return { immediate: true, message: 'Nodeサーバを再起動します。数秒で復帰し、自己診断（撮影→合成→アップ）を実行します。' };
        }
        case 'mac': {
            mode.startMaintenance({ reason: '管理画面: EggCameraMac再起動' });
            marker('管理画面からEggCameraMacを再起動。');
            await kickstart('com.eggcamera.mac');
            await wait(3000);
            // 撮影に効くトリガ受信 :8082 のみで判定（:8081 はUSB移行で不要）
            const ports = await sh('bash', ['-lc', "lsof -nP -iTCP:8082 -sTCP:LISTEN 2>/dev/null | grep -c LISTEN"]);
            selftest.run({ reason: 'EggCameraMac再起動後' }).catch(() => {});
            return { immediate: false, message: `EggCameraMacを再起動しました（:8082待受=${parseInt(ports.out, 10) || 0}）。自己診断を実行中です。` };
        }
        case 'iphone': {
            mode.startMaintenance({ reason: '管理画面: iPhoneアプリ再起動' });
            marker('管理画面からiPhoneアプリを再起動。');
            await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['restart'], { cwd: IPHONE_DIR });
            await wait(5000);
            const code = await httpCode(IPHONE_FRAME);
            selftest.run({ reason: 'iPhoneアプリ再起動後' }).catch(() => {});
            return { immediate: false, message: `iPhoneアプリを再起動しました（:8080/frame=${code}）。自己診断を実行中です。` };
        }
        case 'iphone-refresh': {
            mode.startMaintenance({ reason: '管理画面: iPhone refresh' });
            marker('管理画面からiPhoneアプリをrefresh（再ビルド→入れ直し）。');
            await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['refresh'], { cwd: IPHONE_DIR, timeout: 420_000 });
            await wait(5000);
            const code = await httpCode(IPHONE_FRAME);
            selftest.run({ reason: 'iPhone refresh後' }).catch(() => {});
            return { immediate: false, message: `iPhoneアプリをrefreshしました（:8080/frame=${code}）。自己診断を実行中です。` };
        }
        case 'iphone-reboot': {
            mode.startMaintenance({ reason: '管理画面: iPhone本体再起動' });
            marker('管理画面からiPhone本体を再起動。');
            await sh(path.join(IPHONE_DIR, 'iphone.sh'), ['reboot'], { cwd: IPHONE_DIR, timeout: 300_000 });
            await wait(8000);
            const code = await httpCode(IPHONE_FRAME);
            selftest.run({ reason: 'iPhone本体再起動後' }).catch(() => {});
            return { immediate: false, message: `iPhone本体を再起動しました（:8080/frame=${code}）。パスコード有りだと端末ロックに注意。自己診断を実行中です。` };
        }
        case 'mac-reboot': {
            mode.startMaintenance({ reason: '管理画面: Mac mini本体再起動', runSelfTestOnBoot: true });
            marker('管理画面からMac mini本体を再起動。復旧後に起動時自己診断。');
            // ガードレール経由で再起動（祖先検査付きラッパー）。admin(node) は launchd 配下なので許可される。
            const r = await sh('sudo', ['-n', '/Library/EggCamera/bin/eggcamera-safe-reboot']);
            if (!r.ok) {
                return { immediate: true, ok: false, message: 'Mac mini再起動の権限がありません。一度だけ `sudo ops/install-reboot-guardrail.sh` でガードレールを設置してください。' };
            }
            return { immediate: true, message: 'Mac mini本体を再起動します。全サービス停止→自動復旧（数分）後に自己診断を実行します。' };
        }
        default:
            return { immediate: false, ok: false, message: `不明な対象: ${target}` };
    }
}

module.exports = { restart };
