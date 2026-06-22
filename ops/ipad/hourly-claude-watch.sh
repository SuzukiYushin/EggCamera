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
# 【重要】旧実装 `pgrep -f 'hourly-claude-watch[.]sh'` は、起動引数(プロンプト)にこのパス文字列を
# 含む別プロセス、特に復旧Claude(`claude --remote-control … <このパスを含むプロンプト>`)に誤マッチし、
# 常駐Claudeが居る限り毎回スキップ＝無音で点検停止する事故を起こした(2026-06-23に6時間停止を観測)。
# 毎時テスト側(hourly-ipad-test.sh)と同じく「実行ファイルの種別」で判定する:
#   ・第1トークンの実行ファイル basename が zsh （= 本物はシェルが直接スクリプトを実行。claudeは basename≠zsh で除外）
#   ・第2トークンのスクリプト basename が hourly-claude-watch.sh （`zsh -c '…'` のツール実行は第2=-c で除外）
#   ・自分自身($$)は除外
others=$(ps -axww -o pid=,command= 2>/dev/null | awk -v self="$$" '
  $1==self {next}
  { ni=split($2,ia,"/"); ns=split($3,sa,"/");
    if (ia[ni]=="zsh" && sa[ns]=="hourly-claude-watch.sh") print $1 }')
if [ -n "$others" ]; then
  echo "[$(date '+%T')] 既に実行中(pids: $others)につき今回はスキップ" >> "$LOG"
  exit 0
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
