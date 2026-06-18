#!/bin/zsh
# com.eggcamera.tunneld（RemoteXPC tunneld）の root LaunchDaemon をインストール/再導入する。
# 冪等: 既存をアンロードしてから再ロードする。何度実行してもよい。
#
#   実行:  sudo /Users/eggcamera/EggCamera/ops/ipad/install-tunneld-daemon.sh
#
# root 必須（/Library/LaunchDaemons への配置と system ドメインへの bootstrap のため）。
set -eu

LABEL="com.eggcamera.tunneld"
SRC="/Users/eggcamera/EggCamera/ops/launchd/${LABEL}.plist"
DST="/Library/LaunchDaemons/${LABEL}.plist"
UDID="00008132-001E2934019A401C"   # iPad

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ root で実行してください:  sudo $0" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "❌ plist が見つからない: $SRC" >&2
  exit 1
fi

echo "== $LABEL を導入 =="

# 既存があれば一旦 bootout（無ければ無視）
launchctl bootout "system/${LABEL}" 2>/dev/null || true

cp "$SRC" "$DST"
chown root:wheel "$DST"
chmod 644 "$DST"
echo "  plist 配置: $DST"

launchctl bootstrap system "$DST"
launchctl enable "system/${LABEL}" 2>/dev/null || true
echo "  bootstrap 完了"

# 起動とレジストリ応答を待つ（最大40秒）
echo "== tunneld レジストリ(:49151) とトンネル確立を待機 =="
ok_reg=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null -m 2 http://127.0.0.1:49151; then ok_reg=1; break; fi
  sleep 1
done
if [ "$ok_reg" -eq 1 ]; then
  echo "  ✅ tunneld レジストリ応答あり (:49151)"
else
  echo "  ⚠ レジストリ(:49151)が応答しません。ログ確認: /Library/Logs/com.eggcamera.tunneld.err.log"
fi

# iPad のトンネルが張れたか（レジストリ JSON に UDID が出るか）
ok_ipad=0
for i in $(seq 1 25); do
  if curl -s -m 2 http://127.0.0.1:49151 2>/dev/null | grep -q "$UDID"; then ok_ipad=1; break; fi
  sleep 1
done
if [ "$ok_ipad" -eq 1 ]; then
  echo "  ✅ iPad($UDID) のトンネル確立を確認"
else
  echo "  ⚠ iPad のトンネル未確立。iPad の電源/WiFi/『信頼(Trust)』承認を確認。"
  echo "    （ガイドアクセス中は Trust ダイアログが自動で消えるため、必要なら一旦解除）"
fi

echo "== 状態 =="
launchctl print "system/${LABEL}" 2>/dev/null | grep -E 'state|pid|program' | head || true
echo "完了。テスト再開:  node /Users/eggcamera/EggCamera/EggCameraNode/tools/ipad-test.js"
