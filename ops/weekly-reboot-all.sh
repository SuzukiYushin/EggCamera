#!/bin/zsh
# 3台一括再起動（スクリプトベース／Claude非依存）。
# 周期: launchd(com.eggcamera.reboot-test, 毎日15:00発火) ＋ 下の周期ゲート(≥40h)で実質2日毎。
#       手動で即時実行したい場合は FORCE_REBOOT=1 を付けてゲートを無視する。
# 流れ: 前リフレッシュ値ログ → iPad再起動+Safari → iPhone再起動+カメラ復帰 →
#        肥大ログtruncate → Mac mini再起動（最後・このスクリプトもここで終了）。
# Mac復帰後の復旧確認・後リフレッシュ値は post-boot-verify / post-boot-claude（launchd）が自動実行。
# 必要権限: iPad/iPhoneはdevicectl/cfgutil(sudo不要)、Macは /etc/sudoers.d/eggcamera-shutdown（パスワードレス）。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LOG="$HOME/Library/Logs/eggcamera-weekly-reboot.log"
IPAD_UDID="00008132-001E2934019A401C"
TOKEN=$(grep -E "^ADMIN_TOKEN=" /Users/eggcamera/EggCamera/EggCameraNode/.env 2>/dev/null | cut -d= -f2)
MARK="http://127.0.0.1:3000/api/test-report"
sz() { stat -f%z "$1" 2>/dev/null || echo 0; }
STATE="$HOME/Library/Logs/eggcamera-reboot-test.last"   # 周期ゲート: 前回Mac再起動を実行した時刻(epoch)
MIN_H=${REBOOT_TEST_MIN_INTERVAL_H:-40}                 # これ未満の経過なら実行しない(毎日15:00発火→実質2日毎)

{
# ── 周期ゲート: launchdは「2日毎」を表現できないため毎日発火＋ここで間引く。
#    stampはMac再起動を実行した時のみ更新→中止/スキップ回は翌日15:00に自動リトライされる。
if [ "${FORCE_REBOOT:-0}" != 1 ]; then
  last=$(cat "$STATE" 2>/dev/null || echo 0)
  elapsed=$(( $(date +%s) - last ))
  if [ "$elapsed" -lt $(( MIN_H * 3600 )) ]; then
    echo "==== $(date '+%F %T') 周期ゲート: 前回Mac再起動から$(( elapsed / 3600 ))h (<${MIN_H}h) → 今回スキップ ===="
    exit 0
  fi
fi
echo "==== $(date '+%F %T') 週次3台再起動 開始 ===="

# テスト実行中ならスキップ（RemoteXPC競合＋テスト中断回避、次回に持ち越し）。
# 注意: 単純な pgrep は post-boot復旧Claudeのプロンプト本文(多行)を誤検知する。
# 実際の node …ipad-test.js だけを PID単位・claude除外・自己マッチ回避([i]) で判定。
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
  echo "テストセッション実行中→今回はスキップ"; echo "==== end (skipped) ===="; exit 0
fi

# DEPLOY-MARKER
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-reboot): 週次3台再起動開始。撮影断・無応答は本作業由来で異常ではない。"}' >/dev/null 2>&1

# ── 前リフレッシュ値（再起動で解消される蓄積の記録）──
echo "[pre] metrics = $(curl -s -m 5 -H "X-Admin-Token: $TOKEN" http://127.0.0.1:3000/api/admin/metrics 2>/dev/null)"
echo "[pre] disk    = $(curl -s -m 5 -H "X-Admin-Token: $TOKEN" http://127.0.0.1:3001/api/admin/disk 2>/dev/null)"
echo "[pre] logs    = iproxy:$(sz "$HOME/Library/Logs/eggcamera-iproxy.out") appium:$(sz "$HOME/Library/Logs/eggcamera-appium.out") tmpappium:$(sz /tmp/appium.log)"
echo "[pre] swap    = $(sysctl -n vm.swapusage 2>/dev/null) tmpdir:$(du -sk /tmp 2>/dev/null | cut -f1)KB"

# ── iPad + iPhone 再起動（検証済みスクリプトを再利用）──
/Users/eggcamera/EggCamera/ops/reboot-all-test.sh

# ── ★ゲート: iPad/iPhoneの復帰を確認してからのみ Mac を再起動する ──
# iPadのCoreDevice再接続が遅いことがあるため、ゲートでも最大180秒リトライしてから判定。
ipad_ok=0; iphone_ok=0
for g in $(seq 1 36); do
  # iPad検出は `list devices` がlaunchd環境で誤陰性のため UDID指定の device info(tunnelState) を使う
  [ "$ipad_ok" != 1 ] && xcrun devicectl device info details --device "$IPAD_UDID" 2>/dev/null | grep -qiE "tunnelState:[[:space:]]*connected" && ipad_ok=1
  [ "$iphone_ok" != 1 ] && { fcode=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:8080/frame 2>/dev/null || echo 000); [ "$fcode" = 200 ] && iphone_ok=1; }
  [ "$ipad_ok" = 1 ] && [ "$iphone_ok" = 1 ] && break
  sleep 5
done
echo "[gate] iPad復帰=$ipad_ok / iPhoneカメラ(frame)=$iphone_ok"

if [ "$ipad_ok" != 1 ] || [ "$iphone_ok" != 1 ]; then
  echo "⚠ iPad/iPhone が未復帰 → Mac mini 再起動を中止（安全のため）"
  curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
    --data "{\"level\":\"alert\",\"text\":\"DEPLOY-MARKER(weekly-reboot): iPad復帰=$ipad_ok iPhone復帰=$iphone_ok のためMac再起動を中止。要確認。\"}" >/dev/null 2>&1
  echo "==== $(date '+%F %T') 中止（iPad/iPhone未復帰） ===="
  exit 1
fi

# ── 肥大ログを truncate（再起動では消えない）──
for f in "$HOME/Library/Logs/eggcamera-iproxy.out" "$HOME/Library/Logs/eggcamera-appium.out" "/tmp/appium.log"; do
  [ -f "$f" ] && : > "$f" && echo "[truncate] $f"
done

# ── Mac mini 再起動（iPad/iPhone復帰確認済みなので実行）──
date +%s > "$STATE"   # 周期ゲートstamp: 実際にMac再起動へ進む時のみ更新
echo "==== $(date '+%F %T') iPad/iPhone復帰OK → Mac mini 再起動 → 復旧はpost-boot-verify/claudeが確認 ===="
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-reboot): iPad/iPhone復帰確認済→Mac mini再起動。launchd自動復旧をpost-bootが確認する。"}' >/dev/null 2>&1
sync
# ガードレール経由で再起動（祖先検査付きラッパー）。weekly は launchd 配下なので許可される。
sudo -n /Library/EggCamera/bin/eggcamera-safe-reboot
} >> "$LOG" 2>&1
