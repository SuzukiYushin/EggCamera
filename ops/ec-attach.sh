#!/bin/zsh
# 遠隔（Termius/SSH）から常駐Claudeセッションに入るためのヘルパー。
#   使い方:  ~/EggCamera/ops/ec-attach.sh
# 既存の 'eggcamera' セッションがあれば attach、無ければ新規シェルで作成。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SESSION="eggcamera"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
else
  echo "セッション '$SESSION' が無いので新規作成（復旧Claudeは未起動。手動なら: claude --continue）"
  exec tmux new-session -s "$SESSION"
fi
