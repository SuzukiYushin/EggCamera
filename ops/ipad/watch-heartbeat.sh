#!/bin/zsh
# :50 claude-watch のハートビート/アラートを /api/test-report（＋alert時はSlack）へ安全に送る。
#
# 目的: 本文に $ や " や 全角括弧・改行 が入っても JSON を壊さない。
#   従来は claude -p が curl --data '{...}' を手組みし、$ を \$ とエスケープして
#   「Bad escaped character in JSON at position …」で 400 弾かれる事故が再発していた
#   （実例 2026-07-08 22:00枠: "R2 0.42GB(\$0,枠内)"）。本文は必ず python3 の json.dumps で
#   妥当な JSON に変換してから送る（本文は env 経由で渡し、シェルの再エスケープを一切挟まない）。
#
# 使い方:
#   ops/ipad/watch-heartbeat.sh info  "WATCH(:50) OK: <1行サマリ>"
#   ops/ipad/watch-heartbeat.sh alert "WATCH(:50) 要確認: <症状と推定原因を1行で>"
# level=alert のときは /Users/eggcamera/EggCamera/.env.slack があれば Slack へも固定タグ付きで通知する
# （正常時=info は Slack に出さない＝スパム防止）。

set -u
level="${1:-info}"
text="${2:-}"
if [ -z "$text" ]; then
  echo "usage: watch-heartbeat.sh <info|alert> <text>" >&2
  exit 2
fi

REPO="/Users/eggcamera/EggCamera"
PY="/usr/bin/python3"; [ -x "$PY" ] || PY="$(command -v python3)"

# /api/test-report へ（JSONは python3 で安全に生成）
body=$(LEVEL="$level" TEXT="$text" "$PY" -c 'import json,os;print(json.dumps({"level":os.environ["LEVEL"],"text":os.environ["TEXT"]},ensure_ascii=False))') || exit 1
curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report \
  -H 'Content-Type: application/json' --data "$body" >/dev/null 2>&1

# alert は Slack へも（固定タグを先頭に付ける）
if [ "$level" = "alert" ] && [ -f "$REPO/.env.slack" ]; then
  url=$(grep -E '^SLACK_WEBHOOK_URL=' "$REPO/.env.slack" | head -1 | cut -d= -f2- | tr -d '"'\''')
  if [ -n "$url" ]; then
    sbody=$(TEXT="$text" "$PY" -c 'import json,os;print(json.dumps({"text":":robot_face: *[Claude点検] claude-watch(:50)* — "+os.environ["TEXT"]},ensure_ascii=False))')
    curl -s -m 8 -X POST "$url" -H 'Content-Type: application/json' --data "$sbody" >/dev/null 2>&1
  fi
fi
