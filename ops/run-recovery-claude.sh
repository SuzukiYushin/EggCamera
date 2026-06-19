#!/bin/zsh
# tmux ペイン内で実行される「対話的」復旧Claude。
# post-boot-claude.sh が tmux セッション 'eggcamera' の中でこれを起動する。
# ヘッドレス claude -p と違い対話モードなので、遠隔から `tmux attach -t eggcamera`
# すれば進捗を見て続行・追加指示ができる。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/eggcamera-post-boot-claude.log"
PROMPT_FILE="/Users/eggcamera/EggCamera/ops/post-boot-recovery-prompt.txt"
cd /Users/eggcamera/EggCamera || exit 1

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
# 対話モード（-p なし）。自動復旧のため権限スキップ。初期プロンプトを投入。
claude --dangerously-skip-permissions "$PROMPT"

echo ""
echo "==== $(date '+%F %T') 復旧Claude 終了。続けるには: claude --continue ====" | tee -a "$LOG"
echo "[このペインは保持されます。再度Claudeを使うには上記コマンド。]"
exec zsh
