#!/bin/zsh
# Mac mini 再起動後の自動復旧確認。
# launchd(LaunchAgent, RunAtLoad) でログイン直後に起動 → サービス起動を待って
# node(3000)/admin(3001)/cloudflared tunnel/appium(4723) の復帰を確認し、
# 結果をログ＋DEPLOY-MARKER＋Slack に記録する。
# セッションが落ちている間の復旧を「自動で記録」しておき、Claude再開時に読む用。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LOG="$HOME/Library/Logs/eggcamera-post-boot-verify.log"
MARK_URL="http://127.0.0.1:3000/api/test-report"

# 起動直後はサービスがまだ立ち上がっていないので待つ
sleep 60

ok_node=0 ok_admin=0 ok_tunnel=0 ok_appium=0

check() {  # $1=URL  → 200系なら0
  local code; code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" "$1" 2>/dev/null || echo 000)
  [[ "$code" =~ ^2 ]]
}

{
echo "==== $(date '+%F %T') Mac再起動後 復旧確認 開始 ===="

# 各サービスを最大120秒リトライ（node/adminは無認証で200が返るルートを叩く）
for i in $(seq 1 24); do
  [ "$ok_node" = 0 ]   && check "http://127.0.0.1:3000/" && { ok_node=1;   echo "[node:3000] OK"; }
  [ "$ok_admin" = 0 ]  && curl -s -o /dev/null -m 5 "http://127.0.0.1:3001/" 2>/dev/null && { ok_admin=1; echo "[admin:3001] OK"; }
  [ "$ok_appium" = 0 ] && check "http://127.0.0.1:4723/status" && { ok_appium=1; echo "[appium:4723] OK"; }
  if [ "$ok_tunnel" = 0 ] && pgrep -f "cloudflared" >/dev/null 2>&1; then ok_tunnel=1; echo "[tunnel] cloudflared 稼働"; fi
  [ "$ok_node" = 1 ] && [ "$ok_admin" = 1 ] && [ "$ok_appium" = 1 ] && [ "$ok_tunnel" = 1 ] && break
  sleep 5
done

# tunnel はログに Registered があればより確実
tunnel_reg="?"
if tail -50 /Library/Logs/com.cloudflare.cloudflared.out.log 2>/dev/null | grep -q "Registered tunnel connection"; then
  tunnel_reg="registered"
fi

SUMMARY="node=$ok_node admin=$ok_admin appium=$ok_appium tunnel=$ok_tunnel($tunnel_reg)"
echo "==== 復旧結果: $SUMMARY ===="

# マーカー（監視へ）
curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' \
  --data "{\"level\":\"info\",\"text\":\"DEPLOY-MARKER(post-boot): Mac再起動後の復旧確認 $SUMMARY\"}" >/dev/null 2>&1

# Slack（.env.slack があれば）
url=""
[[ -f "$HOME/EggCamera/.env.slack" ]] && url=$(grep -m1 '^SLACK_WEBHOOK_URL=' "$HOME/EggCamera/.env.slack" | cut -d= -f2-)
if [[ -n "$url" ]]; then
  allok="✅ 全復旧"
  [ "$ok_node$ok_admin$ok_appium$ok_tunnel" = "1111" ] || allok="⚠ 一部未復旧"
  curl -sS -m 10 -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\":arrows_counterclockwise: *EggCamera Mac再起動後復旧* ${allok}\n${SUMMARY}\"}" "$url" >/dev/null 2>&1
fi

echo "==== $(date '+%F %T') 復旧確認 完了 ===="
} >> "$LOG" 2>&1
