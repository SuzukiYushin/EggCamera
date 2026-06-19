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

# テスト用Appiumセッションが走っていないこと（RemoteXPC競合回避）。
# 注意: 単純な `pgrep -f ipad-test.js` は post-boot復旧Claudeのプロンプト本文(多行)に
# "ipad-test.js"/"node" が含まれて誤検知する。実際の node …ipad-test.js だけを
# PID単位・claude(dangerously-skip-permissions)除外・自己マッチ回避([i]) で判定する。
running_ipad_test() {
  local pid cmd
  for pid in $(pgrep -f '[i]pad-test\.js' 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null | tr '\n' ' ')
    case "$cmd" in
      (*dangerously-skip-permissions*) continue ;;
      (*node*ipad-test.js*) return 0 ;;
    esac
  done
  return 1
}
if running_ipad_test; then
  echo "⚠ node ipad-test.js 実行中。競合回避のため中止。"; exit 2
fi

# ───── 1) iPad （WiFi再起動→Safari起動まで検証済みスクリプトに委譲）─────
# devicectl reboot + tunnelState待ち + process launch を、本番(USB無し)で実証済みの
# ipad-wifi-reboot.sh(WiFi再起動→Safari起動成功で完了判定)に置換。USB依存・偽陽性検知を排除。
echo "[iPad] WiFi再起動+Safari起動（ipad-wifi-reboot.sh）…"
if /Users/eggcamera/EggCamera/ops/ipad/ipad-wifi-reboot.sh; then
  ipad_back=1
else
  ipad_back=0; echo "[iPad] ⚠ ipad-wifi-reboot.sh 失敗/未完了"
fi

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
