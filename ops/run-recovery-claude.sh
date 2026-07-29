#!/bin/zsh
# tmux ペイン内で実行される「対話的」復旧Claude。
# post-boot-claude.sh が tmux セッション 'eggcamera' の中でこれを起動する。
# ヘッドレス claude -p と違い対話モードなので、遠隔から `tmux attach -t eggcamera`
# すれば進捗を見て続行・追加指示ができる。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/eggcamera-post-boot-claude.log"
PROMPT_FILE="/Users/eggcamera/EggCamera/ops/post-boot-recovery-prompt.txt"
SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"
NODE_OUT="$HOME/Library/Logs/eggcamera-node.out"
NODE_ERR="$HOME/Library/Logs/eggcamera-node.err"
cd /Users/eggcamera/EggCamera || exit 1

# 通知系は hourly-ipad-test.sh と同じ流儀（マーカーは常に、Slackは要対応時のみ）。
post_marker() { # level text
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data "$(printf '{"level":"%s","text":"DEPLOY-MARKER(post-boot-claude): %s"}' "$1" "$2")" >/dev/null 2>&1
}
notify_slack() { # tag text
  [ -f "$SLACK_ENV" ] || return 0
  local url; url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
  [ -n "$url" ] || return 0
  curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":"%s\n*post-boot-claude* %s"}' "$1" "$2")" "$url" >/dev/null 2>&1
}

echo "==== $(date '+%F %T') tmux復旧Claude: サービス起動待ち(90s) ====" | tee -a "$LOG"
echo "（遠隔接続: ssh eggcamera@... → tmux attach -t eggcamera）"
sleep 90

# iPad恒久setup(appium-tunnel daemon / registry:42314 / iPad usbmux生存)を自動検証し
# DEPLOY-MARKERを投稿。usbmux脱落(要USB-C抜き差し)ならalertになる。Claude復旧(D)の前に
# 確定診断しておくことで、Mac再起動後の検証が手動実行なしで全自動になる。
echo "==== $(date '+%F %T') iPad恒久setup 再起動後検証 ====" | tee -a "$LOG"
/Users/eggcamera/EggCamera/ops/ipad/verify-after-reboot.sh 2>&1 | tee -a "$LOG"

echo "==== $(date '+%F %T') 復旧Claude(対話) 起動 ====" | tee -a "$LOG"
PROMPT="$(cat "$PROMPT_FILE")"
# 無人起動時に初回オンボーディング(テーマ選択画面)で固まるのを防ぐため、起動直前に
# ~/.claude.json の hasCompletedOnboarding=true を保証する。これが無いと claude が
# テーマ選択で停止し復旧不能になる(2026-06-20の再起動テストで発生)。VSCode拡張が
# ~/.claude.json を上書きしてフラグを失う既知issue対策として毎回入れ直す。
python3 -c "import json,os;p=os.path.expanduser('~/.claude.json');d=json.load(open(p)) if os.path.exists(p) else {};d['hasCompletedOnboarding']=True;d.setdefault('projects',{}).setdefault('/Users/eggcamera/EggCamera',{})['hasTrustDialogAccepted']=True;json.dump(d,open(p,'w'))" 2>/dev/null || true

# ── 認証: 無人セッションは長期トークンを優先して使う ──
# 2026-07-12・07-13 の再起動で、claude が起動直後に "Login expired · Please run /login" だけを
# 出して沈黙し、復旧A〜EもiPadテストも丸ごとスキップされた(07-13は10時間誰も気づかなかった)。
# ~/.claude/.credentials.json は VSCode拡張・毎時watch・本セッションで共有され、アクセストークンは
# 8時間で失効する。誰かがリフレッシュするとトークンがローテートされ、古い値を握った他プロセスが
# 巻き添えで失効する(この競合はCC本体でも v2.1.202/203 で修正が続いている領域)。
# `claude setup-token` で発行した1年トークンを .env.claude に置いておけば、無人セッションは
# 共有credentialsのリフレッシュ競合から外れる。未設置なら従来どおり共有credentialsで動く。
CLAUDE_ENV="/Users/eggcamera/EggCamera/.env.claude"
if [ -f "$CLAUDE_ENV" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$CLAUDE_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')"
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "認証: 長期トークン(.env.claude)を使用" | tee -a "$LOG"
fi

# ── 認証プリフライト ──
# 上の長期トークンが未設置の間も無言死だけは避ける。軽量プロンプトで疎通を確かめ、
# 落ちていれば間隔を空けて粘り、それでもダメなら「黙って死ぬ」代わりにSlackで人を呼ぶ。
AUTH_TRIES=5
auth_ok() {
  local out rc
  out="$(claude -p 'reply with exactly: ok' 2>&1)"; rc=$?
  [ $rc -eq 0 ] || return 1
  echo "$out" | grep -qiE 'login expired|not logged in|run /login' && return 1
  return 0
}
i=1
while true; do
  if auth_ok; then
    echo "==== $(date '+%F %T') 認証OK (試行 $i/$AUTH_TRIES) ====" | tee -a "$LOG"
    break
  fi
  echo "==== $(date '+%F %T') ⚠ 認証NG (試行 $i/$AUTH_TRIES) ====" | tee -a "$LOG"
  if [ "$i" -ge "$AUTH_TRIES" ]; then
    MSG="復旧Claudeが認証切れで起動できない(Login expired・${AUTH_TRIES}回試行)。復旧A〜EとiPadテストは未実行。対処: claude setup-token で長期トークンを発行し .env.claude に置く(恒久)／暫定は tmux attach -t eggcamera → claude → /login。"
    echo "==== $(date '+%F %T') ❌ $MSG ====" | tee -a "$LOG"
    post_marker alert "$MSG"
    notify_slack ":wrench: *要修正：手動ログインが必要*" "$MSG"
    exec zsh   # ペインは残す(このまま claude → /login で手当てできる)
  fi
  i=$((i+1))
  sleep 60
done

# ── 無言死ウォッチドッグ ──
# 認証以外(APIエラー・ハング等)で復旧Claudeが黙って止まっても、(E)のマーカーもSlack通知も
# 本人が出す設計なので誰も気づけない。起動時刻を控えて別プロセスで見張り、期限までに
# マーカーが出なければ人を呼ぶ。正常時は起動から概ね30分でマーカーが出る(45分見ておく)。
WATCHDOG_MIN=45
START_ISO="$(date -u '+%Y-%m-%dT%H:%M:%S')"
(
  sleep $((WATCHDOG_MIN * 60))
  # node は /api/test-report を stdout/stderr に流すだけなので、マーカーはlaunchdのログに出る。
  if ! grep -h 'DEPLOY-MARKER(post-boot-claude)' "$NODE_OUT" "$NODE_ERR" 2>/dev/null \
       | awk -v s="$START_ISO" '{ ts=substr($1,2,19); if (ts >= s) f=1 } END { exit !f }'; then
    MSG="復旧Claudeが起動から${WATCHDOG_MIN}分たってもDEPLOY-MARKERを出していない(停止/ハングの疑い)。復旧確認とiPadテストが未完の可能性。tmux attach -t eggcamera で確認を。"
    post_marker alert "$MSG"
    notify_slack ":mag: *要調査：原因を確認*" "$MSG"
  fi
) &
# 対話モード（-p なし）。自動復旧のため権限スキップ。初期プロンプトを投入。
# --remote-control: 再起動後にこの復旧セッションを claude.ai/code・モバイルアプリから
#   遠隔操作できるようにする（セッション名 eggcamera-postboot で固定）。Remote Control は
#   ローカルプロセス依存のため、遠隔操作可能なのは この claude が生きている間
#   （= 復旧A〜E ＋ ipad-test の完走、概ね20分強）のみ。終了後（exec zsh）も遠隔操作したい
#   場合は手動で `claude --remote-control` を再実行する（teleportとは併用不可）。
# CLAUDE_CODE_AUTO_CONNECT_IDE=false: 2026-07-15、Mac mini上でVSCodeが起動中だと
#   claude が cwd 一致の ~/.claude/ide/*.lock を検出して IDE 統合へ自動接続してしまい、
#   --remote-control が握りつぶされる事象を確認（実行プロセスが VSCode拡張の
#   native-binary に化け、引数から --remote-control が消えていた）。IDE自動接続を無効化して回避。
#   値は "0" ではなく文字列 "false" が正（"0"では効果なしを実機確認済み・2026-07-15）。
CLAUDE_CODE_AUTO_CONNECT_IDE=false claude --remote-control "eggcamera-postboot" --dangerously-skip-permissions "$PROMPT"

echo ""
echo "==== $(date '+%F %T') 復旧Claude 終了。続けるには: claude --continue ====" | tee -a "$LOG"
echo "[このペインは保持されます。再度Claudeを使うには上記コマンド。]"
exec zsh
