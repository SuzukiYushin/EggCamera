#!/bin/zsh
# iPad朝の復帰(夜間スリープ運用の対・2026-07-11〜USB復旧まで)
# WDA sessionless /wda/unlock で画面復帰しキオスクSafariへ戻す。
# launchd: com.eggcamera.ipad-wake (毎日8:30)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -u
FWD="http://127.0.0.1:18100"
FLAG="/Users/eggcamera/EggCamera/ops/ipad/.ipad-sleeping"
LOG="$HOME/Library/Logs/eggcamera-ipad-sleep.log"
IPAD_UDID="00008132-001E2934019A401C"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# WDA構成の生存確認(スリープ中に死んでいたら再建。iPadがWi-Fi切断だと失敗し得る)
if ! /Users/eggcamera/EggCamera/ops/ipad/wda-wifi-recovery.sh >> "$LOG" 2>&1; then
  log "❌ WDA構成復旧失敗(iPadがWi-Fi切断=ディープスリープの可能性)→devicectlでSafari起動を試行"
  # CoreDevice経由の起動試行(ネットワーク到達できればwakeする)
  xcrun devicectl device process launch --device "$IPAD_UDID" com.apple.mobilesafari >> "$LOG" 2>&1
  sleep 10
  /Users/eggcamera/EggCamera/ops/ipad/wda-wifi-recovery.sh >> "$LOG" 2>&1 || {
    log "❌ 復帰失敗→要人間対応(iPad画面を物理タップ)"
    curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
      --data '{"level":"alert","text":"DEPLOY-MARKER(ipad-wake): 朝の自動復帰失敗。iPadがWi-Fi切断の可能性→画面を物理タップして起こしてください"}' >/dev/null 2>&1
    SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"
    [ -f "$SLACK_ENV" ] && source "$SLACK_ENV" && \
      curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-type: application/json' \
        -d '{"text":":electric_plug: *要物理操作* iPad朝の自動復帰失敗(Wi-Fi切断)。iPad画面をタップして起こしてください。"}' >/dev/null
    exit 1
  }
fi

# アンロック(反映が遅れることがあるため最大60秒リトライ確認)
curl -s -m 10 -X POST "$FWD/wda/unlock" -H "Content-Type: application/json" -d "{}" > /dev/null
locked=""
for i in {1..12}; do
  sleep 5
  locked=$(curl -s -m 10 "$FWD/wda/locked" | grep -oE '"value"[[:space:]]*:[[:space:]]*false' || true)
  [ -n "$locked" ] && break
  # まだロック中なら再送
  curl -s -m 10 -X POST "$FWD/wda/unlock" -H "Content-Type: application/json" -d "{}" > /dev/null
done
if [ -n "$locked" ]; then
  rm -f "$FLAG"
  log "✅ iPad復帰(アンロック)成功→毎時テスト再開可"
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data '{"level":"info","text":"DEPLOY-MARKER(ipad-wake): 朝の復帰完了(毎時テスト再開)"}' >/dev/null 2>&1
else
  log "⚠ アンロック確認できず"
  exit 1
fi
