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
# 無人起動時に初回オンボーディング(テーマ選択画面)で固まるのを防ぐため、起動直前に
# ~/.claude.json の hasCompletedOnboarding=true を保証する。これが無いと claude が
# テーマ選択で停止し復旧不能になる(2026-06-20の再起動テストで発生)。VSCode拡張が
# ~/.claude.json を上書きしてフラグを失う既知issue対策として毎回入れ直す。
python3 -c "import json,os;p=os.path.expanduser('~/.claude.json');d=json.load(open(p)) if os.path.exists(p) else {};d['hasCompletedOnboarding']=True;d.setdefault('projects',{}).setdefault('/Users/eggcamera/EggCamera',{})['hasTrustDialogAccepted']=True;json.dump(d,open(p,'w'))" 2>/dev/null || true
# 対話モード（-p なし）。自動復旧のため権限スキップ。初期プロンプトを投入。
# --remote-control: 再起動後にこの復旧セッションを claude.ai/code・モバイルアプリから
#   遠隔操作できるようにする（セッション名 eggcamera-postboot で固定）。Remote Control は
#   ローカルプロセス依存のため、遠隔操作可能なのは この claude が生きている間
#   （= 復旧A〜E ＋ ipad-test の完走、概ね20分強）のみ。終了後（exec zsh）も遠隔操作したい
#   場合は手動で `claude --remote-control` を再実行する（teleportとは併用不可）。
claude --remote-control "eggcamera-postboot" --dangerously-skip-permissions "$PROMPT"

echo ""
echo "==== $(date '+%F %T') 復旧Claude 終了。続けるには: claude --continue ====" | tee -a "$LOG"
echo "[このペインは保持されます。再度Claudeを使うには上記コマンド。]"
exec zsh
