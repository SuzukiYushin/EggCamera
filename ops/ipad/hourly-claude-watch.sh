#!/bin/zsh
# 毎時:50に Claude(claude -p ヘッドレス) で運用監視を実行する常設ジョブ。
# launchd(LaunchAgent, com.eggcamera.hourly-claude-watch)から起動される。
#
# 位置づけ: shell の hourly-test-watchdog(:50, 毎時テストのpass/fail判定+Slack)とは別レイヤの
#   「Claudeによる総合点検」。metrics肥大/disk/プレビュー高頻度再燃/通信量などを横断的に見て、
#   人間の確認が要る異常だけを /api/test-report(alert) と Slack に通知する（正常時は無通知）。
# 注: Claude純正のアプリ通知(端末プッシュ)は Remote Control 付きの生きたセッションが要るため、
#   この無人ジョブからは出せない。通知は Slack(+test-report) 経由＝Slackアプリで端末に届く。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/eggcamera-hourly-claude-watch.log"
CLAUDE="/opt/homebrew/bin/claude"
PROMPT_FILE="/Users/eggcamera/EggCamera/ops/hourly-claude-watch-prompt.txt"
MAX_SEC=600   # 暴走/長考の保険。これを超えたら強制終了する。深掘り調査(実測値・不変条件の裏取り)のため300→600に拡大。
cd /Users/eggcamera/EggCamera || exit 1

echo "==== $(date '+%F %T') hourly-claude-watch 起動 ====" >> "$LOG"

# 多重起動防止（前回が MAX_SEC 超で生きていたら今回はスキップ）
if pgrep -f 'hourly-claude-watch[.]sh' | grep -qv "^$$\$"; then
  # 自分以外に同名スクリプトが走っていれば二重起動とみなしスキップ
  others=$(pgrep -f 'hourly-claude-watch[.]sh' | grep -v "^$$\$")
  if [ -n "$others" ]; then
    echo "[$(date '+%T')] 既に実行中(pids: $others)につき今回はスキップ" >> "$LOG"
    exit 0
  fi
fi

# 無人起動時に初回オンボーディング(テーマ選択)で固まるのを防ぐ（VSCode拡張が
# ~/.claude.json を上書きしフラグを失う既知issue対策。post-boot側と同じ保険）。
python3 -c "import json,os;p=os.path.expanduser('~/.claude.json');d=json.load(open(p)) if os.path.exists(p) else {};d['hasCompletedOnboarding']=True;d.setdefault('projects',{}).setdefault('/Users/eggcamera/EggCamera',{})['hasTrustDialogAccepted']=True;json.dump(d,open(p,'w'))" 2>/dev/null || true

PROMPT="$(cat "$PROMPT_FILE")"

# claude -p をバックグラウンド実行し、MAX_SEC で打ち切る（timeout コマンドが無いため自前）。
"$CLAUDE" -p --dangerously-skip-permissions "$PROMPT" >> "$LOG" 2>&1 &
CPID=$!
( sleep "$MAX_SEC"; kill -TERM "$CPID" 2>/dev/null; sleep 5; kill -KILL "$CPID" 2>/dev/null ) &
WPID=$!
wait "$CPID" 2>/dev/null
RC=$?
kill "$WPID" 2>/dev/null  # claude が時間内に終わったら打ち切りタイマーを解除

echo "==== $(date '+%F %T') hourly-claude-watch 終了(rc=$RC) ====" >> "$LOG"
