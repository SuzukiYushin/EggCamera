#!/bin/zsh
# 週次メンテ: iPad再起動 → SafariをフォトブースURLで再起動 → 肥大ログをtruncate。
# すべて sudo 不要（Apple純正 devicectl）。本番は iPad が WiFi のみでも devicectl は
# .coredevice.local 経由で到達する。
#
# 目的:
#  - iPad Safari を常時開放にした副作用（WebKitメモリ蓄積）を週次再起動でリセット
#  - 再起動でSafariが閉じる問題を devicectl --payload-url の自動起動で解消
#  - 再起動では消えない肥大ログ(iproxy/appium)を truncate
# Mac mini はスマートプラグ→UPS(upsreboot.sh)で別途再起動。iPhoneは refresh-cron.sh(毎日)。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

IPAD_UDID="00008132-001E2934019A401C"   # EggCameraのiPad
URL="http://192.168.10.104:3000/"
LOG="$HOME/Library/Logs/eggcamera-weekly-maint.log"
MARK_URL="http://127.0.0.1:3000/api/test-report"

{
echo "==== $(date '+%F %T') 週次メンテ開始 ===="

# テスト実行中はRemoteXPC競合＋テスト中断を避けてスキップ（次回持ち越し）
if pgrep -f "ipad-test.js" >/dev/null 2>&1; then
  echo "テストセッション実行中のためスキップ"
  echo "==== end (skipped) ===="
  exit 0
fi

# 監視へDEPLOY-MARKER（一時的な撮影断を障害扱いさせない）
curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-maint): iPad再起動+Safari再開+ログtruncate。一時的なプレビュー断は本作業由来で異常ではありません。"}' \
  >/dev/null 2>&1 && echo "marker投稿OK"

# 1) iPad再起動
echo "iPad再起動コマンド送信…"
xcrun devicectl device reboot --device "$IPAD_UDID" && echo "  OK" || echo "  失敗"

# 2) 復帰待ち（最大180秒、名前で connected を確認）
back=0
for i in $(seq 1 36); do
  sleep 5
  if xcrun devicectl list devices 2>/dev/null | grep "EggCameraのiPad" | grep -q connected; then
    echo "iPad復帰確認（${i}回ポーリング）"; back=1; break
  fi
done
[ "$back" = 1 ] || echo "⚠ iPad復帰未確認（180秒）。Safari起動を試行する。"
sleep 10  # 起動直後の安定待ち

# 3) SafariをフォトブースURLで起動（キオスク表示の自動復帰）
echo "Safari起動（$URL）…"
xcrun devicectl device process launch --device "$IPAD_UDID" \
  com.apple.mobilesafari --payload-url "$URL" >/dev/null 2>&1 \
  && echo "  Safari起動OK" || echo "  Safari起動失敗（要手動確認）"

# 4) 肥大ログを truncate（再起動では消えない・追記モードなので in-place 切り詰めで安全）
echo "ログtruncate…"
for f in "$HOME/Library/Logs/eggcamera-iproxy.out" \
         "$HOME/Library/Logs/eggcamera-appium.out" \
         "/tmp/appium.log"; do
  if [ -f "$f" ]; then : > "$f" && echo "  truncated: $f"; fi
done

# 完了マーカー
curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-maint): 週次メンテ完了。iPad/Safari復帰・ログ整理済み。"}' \
  >/dev/null 2>&1

echo "==== $(date '+%F %T') 週次メンテ完了 ===="
} >> "$LOG" 2>&1
