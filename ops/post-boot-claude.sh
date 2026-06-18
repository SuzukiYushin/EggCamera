#!/bin/zsh
# Mac mini 再起動後に、復旧確認Claudeを「tmux内の対話セッション」として常駐起動する。
# launchd(LaunchAgent, RunAtLoad)でログイン直後に走る。
#
# 旧方式: claude -p（ヘッドレス/非対話）→ 遠隔から覗けず、続行もできなかった。
# 新方式: tmux セッション 'eggcamera' を即座に作り、その中で run-recovery-claude.sh を実行。
#   - セッションは起動直後から存在するので、遠隔SSHからいつでも attach 可能:
#       ssh eggcamera@... → tmux attach -t eggcamera   （または ~/EggCamera/ops/ec-attach.sh）
#   - 中の Claude が A〜E の復旧・テスト・報告を対話モードで自動実行し、
#     終了後もペインは保持されるので、そのまま追加指示や `claude --continue` ができる。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/eggcamera-post-boot-claude.log"
SESSION="eggcamera"
TMUX_BIN="/opt/homebrew/bin/tmux"
RUNNER="/Users/eggcamera/EggCamera/ops/run-recovery-claude.sh"
cd /Users/eggcamera/EggCamera || exit 1

echo "==== $(date '+%F %T') post-boot claude(tmux) 起動 ====" >> "$LOG"

# 既存セッションがあれば作り直し（再ブート時の取りこぼし防止）
"$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null && "$TMUX_BIN" kill-session -t "$SESSION"

# tmux セッションを即作成し、中で復旧ランナーを実行（ランナーが90s待機→対話Claude）
"$TMUX_BIN" new-session -d -s "$SESSION" -x 220 -y 50 "$RUNNER"

echo "==== $(date '+%F %T') tmux '$SESSION' 起動完了。遠隔: tmux attach -t $SESSION ====" >> "$LOG"
