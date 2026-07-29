#!/bin/zsh
# iPad夜間スリープ(USB切断期間の省電力運用・2026-07-11〜USB復旧まで)
# WDA(Wi-Fi構成)のsessionless /wda/lock で画面ロック=スリープさせる。
# launchd: com.eggcamera.ipad-sleep (毎日23:30)
# 復帰は ipad-wake.sh (毎日8:30)。USB復旧後は両launchdをbootoutしフラグ削除。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -u
FWD="http://127.0.0.1:18100"
FLAG="/Users/eggcamera/EggCamera/ops/ipad/.ipad-sleeping"
LOG="$HOME/Library/Logs/eggcamera-ipad-sleep.log"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 毎時テスト実行中なら終わるまで待つ(最大25分・23:00枠は23:20頃終了)
for i in {1..50}; do
  ps -axww -o command= | awk '{n=split($1,a,"/")} a[n]=="node" && index($0,"tools/ipad-test.js")>0 {found=1} END{exit found?0:1}' || break
  sleep 30
done

# WDA構成の生存確認(死んでいれば再建)
/Users/eggcamera/EggCamera/ops/ipad/wda-wifi-recovery.sh >> "$LOG" 2>&1 || { log "❌ WDA構成復旧失敗→スリープ断念"; exit 1; }

# フラグを先に立てる(毎時テストのスキップ判定)
echo "$(date '+%F %T') sleep" > "$FLAG"

# ロック実行(反映が遅れることがあるため最大60秒リトライ確認)
curl -s -m 10 -X POST "$FWD/wda/lock" -H "Content-Type: application/json" -d "{}" > /dev/null
locked=""
for i in {1..12}; do
  sleep 5
  locked=$(curl -s -m 10 "$FWD/wda/locked" | grep -oE '"value"[[:space:]]*:[[:space:]]*true' || true)
  [ -n "$locked" ] && break
  curl -s -m 10 -X POST "$FWD/wda/lock" -H "Content-Type: application/json" -d "{}" > /dev/null
done
if [ -n "$locked" ]; then
  log "✅ iPadスリープ(画面ロック)成功"
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data '{"level":"info","text":"DEPLOY-MARKER(ipad-sleep): 夜間スリープ開始(省電力・毎時テストは朝までスキップ)"}' >/dev/null 2>&1
else
  log "⚠ ロック確認できず(WDA応答なし or ロック失敗)"
  rm -f "$FLAG"
  exit 1
fi
