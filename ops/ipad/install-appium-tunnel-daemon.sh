#!/bin/zsh
# com.eggcamera.appium-tunnel(Appium公式トンネル)の root LaunchDaemon を導入し、
# 誤っていた com.eggcamera.tunneld(pymobiledevice3)を撤去する。冪等。
#
#   実行:  sudo /Users/eggcamera/EggCamera/ops/ipad/install-appium-tunnel-daemon.sh
#
# 事前に: 手動 foreground の `sudo appium driver run xcuitest tunnel-creation` が動いていれば
#         Ctrl-C で止めること（:42314 競合回避）。
set -eu

NEW_LABEL="com.eggcamera.appium-tunnel"
OLD_LABEL="com.eggcamera.tunneld"
SRC="/Users/eggcamera/EggCamera/ops/launchd/${NEW_LABEL}.plist"
DST="/Library/LaunchDaemons/${NEW_LABEL}.plist"
OLD_DST="/Library/LaunchDaemons/${OLD_LABEL}.plist"
IPAD="00008132-001E2934019A401C"

if [ "$(id -u)" -ne 0 ]; then echo "❌ sudo で実行してください: sudo $0" >&2; exit 1; fi
if [ ! -f "$SRC" ]; then echo "❌ plist が無い: $SRC" >&2; exit 1; fi

# :42314 が既に使用中（foregroundのtunnel-creation残存）なら中止
if lsof -nP -iTCP:42314 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ ポート42314が使用中です。手動foregroundの tunnel-creation を Ctrl-C で止めてから再実行してください。" >&2
  exit 2
fi

echo "== 誤りの $OLD_LABEL を撤去 =="
launchctl bootout "system/${OLD_LABEL}" 2>/dev/null || true
rm -f "$OLD_DST" && echo "  removed $OLD_DST (なければスキップ)"

echo "== $NEW_LABEL を導入 =="
launchctl bootout "system/${NEW_LABEL}" 2>/dev/null || true
cp "$SRC" "$DST"; chown root:wheel "$DST"; chmod 644 "$DST"
launchctl bootstrap system "$DST"
launchctl enable "system/${NEW_LABEL}" 2>/dev/null || true
echo "  bootstrap 完了"

echo "== レジストリ起動待ち(最大40s) =="
port=""
for i in $(seq 1 40); do
  port=$(cat "/Users/eggcamera/Library/Application Support/appium-xcuitest-driver-nodejs/strongbox/tunnelRegistryPort" 2>/dev/null || echo "")
  if [ -n "$port" ] && curl -s -o /dev/null -m 2 "http://localhost:${port}/remotexpc/tunnels"; then break; fi
  sleep 1
done
if [ -n "$port" ]; then
  echo "  ✅ strongbox tunnelRegistryPort=$port"
  echo "  レジストリ内容:"; curl -s -m 3 "http://localhost:${port}/remotexpc/tunnels" | python3 -c "import sys,json;d=json.load(sys.stdin);print('   tunnels:',list(d.get('tunnels',{}).keys()))" 2>/dev/null || true
  curl -s -m 3 "http://localhost:${port}/remotexpc/tunnels" | grep -q "$IPAD" && echo "  ✅ iPad($IPAD) 登録あり" || echo "  ⚠ iPad未登録（usbmuxに居るか確認: pymobiledevice3 usbmux list / 必要ならUSB-C抜き差し→ sudo launchctl kickstart -k system/$NEW_LABEL）"
else
  echo "  ⚠ レジストリ未応答。ログ: /Library/Logs/com.eggcamera.appium-tunnel.err.log"
fi
echo "完了。テスト: node /Users/eggcamera/EggCamera/EggCameraNode/tools/ipad-test.js"
