#!/bin/zsh
# Mac mini → Cloudflare Watchdog Worker へ5分ごとにビートを送る（launchdから起動）。
# node に依存しない（Mac mini と回線が生きていれば送れる）ので、丸ごと落ちた時だけ
# Worker 側の Cron が Slack に通知する。
#
# 設定: ~/EggCamera/.env.watchdog （git管理外）
#   WATCHDOG_URL=https://eggcamera-watchdog.<subdomain>.workers.dev
#   BEAT_SECRET=<wrangler secret put BEAT_SECRET と同じ値>
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
ENV="$HOME/EggCamera/.env.watchdog"
[[ -f "$ENV" ]] || exit 0
set -a; source "$ENV"; set +a
[[ -n "$WATCHDOG_URL" && -n "$BEAT_SECRET" ]] || exit 0
curl -s -m 10 -X POST "${WATCHDOG_URL}/beat" -H "X-Beat-Secret: ${BEAT_SECRET}" >/dev/null 2>&1
