#!/bin/zsh
# 3台再起動テストの前半: iPad → iPhone を再起動し、各々の復帰を確認する。
# Mac mini は最後に別途 `sudo -n /sbin/shutdown -r now` で（このスクリプトには含めない＝
# 呼び出し側が iPad/iPhone 復帰を確認してから最後に撃つ）。
# iPad/iPhone は sudo 不要（Apple devicectl）。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

IPAD_UDID="00008132-001E2934019A401C"
URL="http://192.168.10.104:3000/"
IPHONE_DIR="/Users/eggcamera/EggCamera/EggCameraIPhone"
IPHONE_FRAME_URL="http://127.0.0.1:8080/frame"
MARK_URL="http://127.0.0.1:3000/api/test-report"

mark() { curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' --data "{\"level\":\"info\",\"text\":\"DEPLOY-MARKER(reboot-test): $1\"}" >/dev/null 2>&1; }

echo "==== $(date '+%F %T') 3台再起動テスト（iPad→iPhone）開始 ===="
mark "3台再起動テスト開始。iPad/iPhone/Mac再起動。一時的な撮影断・無応答は本テスト由来で異常ではありません。"

# テスト用Appiumセッションが走っていないこと（RemoteXPC競合回避）
if pgrep -f "ipad-test.js" >/dev/null 2>&1; then
  echo "⚠ ipad-test.js 実行中。競合回避のため中止。"; exit 2
fi

# ───── 1) iPad ─────
echo "[iPad] 再起動…"
xcrun devicectl device reboot --device "$IPAD_UDID" && echo "[iPad] reboot送信OK" || echo "[iPad] reboot送信失敗"
ipad_back=0
# iPad は CoreDevice トンネルの再接続に4分以上かかることがある（180秒では不足）。
# 最大420秒（7分）まで待つ。
for i in $(seq 1 84); do
  sleep 5
  # iPad復帰検出: `list devices`はlaunchd環境で誤陰性(connected表示されず)になるため、
  # `device reboot`同様にlaunchdでも確実に効く UDID指定の `device info` + tunnelState を使う。
  if xcrun devicectl device info details --device "$IPAD_UDID" 2>/dev/null | grep -qiE "tunnelState:[[:space:]]*connected"; then
    echo "[iPad] 復帰確認（${i}回ポーリング/$((i*5))秒）"; ipad_back=1; break
  fi
done
[ "$ipad_back" = 1 ] || echo "[iPad] ⚠ 420秒以内に復帰未確認"
sleep 10
echo "[iPad] Safari起動（$URL）…"
xcrun devicectl device process launch --device "$IPAD_UDID" com.apple.mobilesafari --payload-url "$URL" >/dev/null 2>&1 \
  && echo "[iPad] Safari起動OK" || echo "[iPad] ⚠ Safari起動失敗"

# ───── 2) iPhone ─────
echo "[iPhone] 再起動…（iphone.sh reboot = devicectl・修正済みでiPhone固定）"
( cd "$IPHONE_DIR" && ./iphone.sh reboot ) 2>&1 | sed 's/^/[iPhone] /'
echo "[iPhone] :8080/frame 復帰確認…"
iphone_back=0
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" "$IPHONE_FRAME_URL" 2>/dev/null || echo 000)
  [ "$code" = 200 ] && { echo "[iPhone] frame=200 復帰確認（$((i*5))秒）"; iphone_back=1; break; }
  sleep 5
done
[ "$iphone_back" = 1 ] || echo "[iPhone] ⚠ frame=200 に戻らず"

# ───── 結果 ─────
echo ""
echo "==== 前半結果: iPad復帰=$ipad_back / iPhone復帰=$iphone_back ===="
echo "（この後、呼び出し側が Mac mini を再起動する）"
mark "iPad復帰=$ipad_back iPhone復帰=$iphone_back。次にMac mini再起動→launchd自動復旧を確認。"
echo "==== $(date '+%F %T') 前半完了 ===="
