#!/bin/zsh
# iPadバッテリー回復のための一時休止(メンテナンスON)を自動解除するワンショットjob。
# com.eggcamera.resume-after-battery(launchd, StartCalendarInterval 20:25)から1回だけ起動され、
# メンテナンスOFF→マーカー投稿→Slack通知→自分自身をbootout+plist削除して消える。
# 設計はops既存流儀(DEPLOY-MARKER前後投稿/Slack通知)に合わせる。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

ENVDIR="/Users/eggcamera/EggCamera/EggCameraNode"
SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"
LABEL="com.eggcamera.resume-after-battery"
PLIST="/Users/eggcamera/Library/LaunchAgents/$LABEL.plist"
LOG="/Users/eggcamera/Library/Logs/eggcamera-resume-after-battery.log"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

TOKEN=$(grep -E '^ADMIN_TOKEN=' "$ENVDIR/.env" | head -1 | cut -d= -f2- | tr -d '"'\'' ' | tr -d '\r')

# 1) メンテナンスOFF(ユーザー操作再開)
resp=$(curl -s -m 8 -X POST http://127.0.0.1:3001/api/admin/maintenance/stop \
  -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' 2>/dev/null)
log "maintenance stop resp: $resp"

# 2) DEPLOY-MARKER(再開) — 監視の誤検知防止
TXT="DEPLOY-MARKER(resume-after-battery): メンテナンスOFF — iPadバッテリー休止(約2時間)を自動解除。キオスク操作＋毎時テストを再開。次の毎時テストでiPadはAppium経由で復帰(画面物理スリープ中なら自動wake)。"
curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
  --data "$(python3 -c 'import json,sys;print(json.dumps({"level":"info","text":sys.argv[1]},ensure_ascii=False))' "$TXT")" >/dev/null 2>&1

# 3) Slack通知
if [ -f "$SLACK_ENV" ]; then
  url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ' | tr -d '\r')
  [ -n "$url" ] && curl -s -m 8 -X POST "$url" -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"text":"▶️ EggCamera 休止自動解除\n"+sys.argv[1]},ensure_ascii=False))' "$TXT")" >/dev/null 2>&1
fi

log "resume done. self-removing."

# 4) 自己除去(明日以降の再発火を防ぐ)。作業完了後に最後に実行。
rm -f "$PLIST" 2>/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
exit 0
