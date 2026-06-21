#!/bin/zsh
# 【非破壊】tunneld 方式で iPad へのトンネルを張り、診断サービス到達を確認する（再起動しない）。
# iOS17+ は CoreDevice の「pairing consent（信頼）」が要る。tunneld を起動したまま
# iPad で『信頼/Trust』をタップすること。iPad がガイドアクセス中だとダイアログが
# 自動で消えるので、その場合は一旦ガイドアクセスを解除してから実行する。
# root 必須: `sudo ops/ipad/ipad-wifi-check.sh`
set -u

PMD="/Users/eggcamera/.local/bin/pymobiledevice3"
UDID="00008132-001E2934019A401C"   # iPad
LOG="$(mktemp /tmp/ipad-tunneld.XXXXXX)"
BAT="$(mktemp /tmp/ipad-bat.XXXXXX)"

if pgrep -f "ipad-test.js" >/dev/null 2>&1; then
  echo "⚠ テストセッション実行中。RemoteXPC が競合するため中止。テスト完了後に再実行。"
  exit 2
fi

"$PMD" remote tunneld > "$LOG" 2>&1 &
TUNPID=$!
cleanup() { kill "$TUNPID" 2>/dev/null; rm -f "$BAT"; }
trap cleanup EXIT

echo "tunneld を起動しました。iPad のトンネル(RSD)確立を待ちます…"
echo "（『信頼/Trust』が iPad に出たらタップ。出なければ承認済み）"

# tunneld ログから iPad(UDID) の RSD（host port）を取り出す
RSD=""
for i in $(seq 1 25); do
  sleep 1
  RSD="$(grep "$UDID" "$LOG" 2>/dev/null | grep -o 'Created tunnel --rsd .*' | tail -1 | sed 's/Created tunnel --rsd //')"
  [ -n "$RSD" ] && break
done

if [ -z "$RSD" ]; then
  echo "❌ iPad のトンネルが作成されませんでした。tunneld ログ末尾 ↓"
  tail -20 "$LOG" | sed 's/^/   /'
  exit 1
fi

HOST="$(echo "$RSD" | awk '{print $1}')"
PORT="$(echo "$RSD" | awk '{print $2}')"
echo "iPad トンネル RSD = $HOST $PORT — diagnostics サービスへ読み取りアクセス（再起動しない）"

# RSD を直接指定して読み取り（diagnostics info は restart と同じサービス経路の読み取り版）
if "$PMD" diagnostics info --rsd "$HOST" "$PORT" > "$BAT" 2>/dev/null; then
  echo ""
  echo "✅ トンネル経由で iPad の diagnostics サービスに到達（＝再起動も可能）"
  head -c 300 "$BAT"; echo ""
  echo "✅ WiFi/トンネル経由のデバイス制御 疎通OK。ipad-reboot.sh で再起動できます。"
else
  echo ""
  echo "❌ RSD は取れたが diagnostics 到達に失敗。実エラー ↓"
  "$PMD" diagnostics info --rsd "$HOST" "$PORT" 2>&1 | tail -15 | sed 's/^/   /'
  exit 1
fi
