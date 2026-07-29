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
# 自分自身($$)に加え、直接の子プロセス(PPID==$$)も除外する。理由: 下の `$(ps|awk)` の
# コマンド置換は zsh のサブシェルを fork し、それは exec 前まで本スクリプトと同じ argv
# (/bin/zsh …/hourly-claude-watch.sh)を持つため、basename 判定だと自分の子サブシェルに自己マッチして
# しまう(2026-06-23観測: $$除外だけでは漏れて毎回スキップ)。本物の別実行は launchd の子=PPID≠$$ なので
# この除外で取り逃さない。
others=$(ps -axww -o pid=,ppid=,command= 2>/dev/null | awk -v self="$$" '
  $1==self || $2==self {next}
  { ni=split($3,ia,"/"); ns=split($4,sa,"/");
    if (ia[ni]=="zsh" && sa[ns]=="hourly-claude-watch.sh") print $1 }')
if [ -n "$others" ]; then
  echo "[$(date '+%T')] 既に実行中(pids: $others)につき今回はスキップ" >> "$LOG"
  exit 0
fi

# 無人起動時に初回オンボーディング(テーマ選択)で固まるのを防ぐ（VSCode拡張が
# ~/.claude.json を上書きしフラグを失う既知issue対策。post-boot側と同じ保険）。
python3 -c "import json,os;p=os.path.expanduser('~/.claude.json');d=json.load(open(p)) if os.path.exists(p) else {};d['hasCompletedOnboarding']=True;d.setdefault('projects',{}).setdefault('/Users/eggcamera/EggCamera',{})['hasTrustDialogAccepted']=True;json.dump(d,open(p,'w'))" 2>/dev/null || true

PROMPT="$(cat "$PROMPT_FILE")"

# ── 認証: 無人ジョブは長期トークンを優先して使う ──
# ~/.claude/.credentials.json は VSCode拡張・復旧Claude・本ジョブで共有され、アクセストークンは
# 8時間で失効する。誰かがリフレッシュするとトークンがローテートされ、古い値を握った他プロセスが
# 巻き添えで失効する。`claude setup-token` の1年トークンを .env.claude に置けば競合から外れる。
# 未設置なら従来どおり共有credentialsで動く（post-boot 側と同じ扱い）。
CLAUDE_ENV="/Users/eggcamera/EggCamera/.env.claude"
if [ -f "$CLAUDE_ENV" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$CLAUDE_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')"
fi

# claude -p をバックグラウンド実行し、MAX_SEC で打ち切る（timeout コマンドが無いため自前）。
LOG_LINES_BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
"$CLAUDE" -p --dangerously-skip-permissions "$PROMPT" >> "$LOG" 2>&1 &
CPID=$!
( sleep "$MAX_SEC"; kill -TERM "$CPID" 2>/dev/null; sleep 5; kill -KILL "$CPID" 2>/dev/null ) &
WPID=$!
wait "$CPID" 2>/dev/null
RC=$?
kill "$WPID" 2>/dev/null  # claude が時間内に終わったら打ち切りタイマーを解除

# ── 認証切れの検知 ──
# 認証が切れていると claude は "Login expired · Please run /login" だけを出して即終了し、
# rc=0 のまま点検が丸ごと飛ぶ。正常時は無通知の設計なので、黙って止まると誰も気づけない
# (2026-07-13、post-boot 側の同じ事故に10時間気づかなかった)。この時だけは人を呼ぶ。
if tail -n +$((LOG_LINES_BEFORE + 1)) "$LOG" 2>/dev/null | grep -qiE 'login expired|not logged in'; then
  MSG="hourly-claude-watch が認証切れで点検できていない(Login expired)。恒久対処: claude setup-token で長期トークンを発行し .env.claude に置く。"
  echo "==== $(date '+%F %T') ❌ $MSG ====" >> "$LOG"
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data "$(printf '{"level":"alert","text":"DEPLOY-MARKER(hourly-claude-watch): %s"}' "$MSG")" >/dev/null 2>&1
  if [ -f "/Users/eggcamera/EggCamera/.env.slack" ]; then
    url=$(grep -E '^SLACK_WEBHOOK_URL=' "/Users/eggcamera/EggCamera/.env.slack" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
    [ -n "$url" ] && curl -s -m 8 -X POST -H 'Content-Type: application/json' \
      --data "$(printf '{"text":":wrench: *要修正：手動ログインが必要*\n*hourly-claude-watch* %s"}' "$MSG")" "$url" >/dev/null 2>&1
  fi
fi

echo "==== $(date '+%F %T') hourly-claude-watch 終了(rc=$RC) ====" >> "$LOG"
