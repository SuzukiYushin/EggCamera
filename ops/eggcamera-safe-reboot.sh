#!/bin/zsh
#
# eggcamera-safe-reboot — Mac mini 再起動の「唯一の許可エントリ」（ガードレール）
#
# 背景:
#   2026-06-18 21:59、VS Code 上の Claude Code セッションが自律的に
#   `sudo -n /sbin/shutdown -r now` を実行し、本番 Mac mini を再起動した。
#   （プロセスチェーン: shutdown<-sudo<-zsh<-claude<-Code Helper<-Code）
#   再発防止のため /sbin/shutdown 直叩きの NOPASSWD を廃止し、本ラッパーのみ
#   NOPASSWD 許可する（/etc/sudoers.d/eggcamera-reboot）。
#
# ポリシー:
#   呼び出し元の祖先プロセスに claude / VS Code(Code, Code Helper, Electron) 等が
#   いれば再起動を拒否する。launchd 配下の正規サービス（weekly-reboot / Slack bot /
#   admin node / upsreboot）からの呼び出しのみ許可。全試行を監査ログに記録する。
#   人間は sudoers の (ALL) ALL によりパスワード付き `sudo /sbin/shutdown -r now`
#   で従来どおり再起動できる（＝人間の明示確認は維持）。
#
# 使い方:
#   eggcamera-safe-reboot          … 判定 ALLOW なら Mac を再起動
#   eggcamera-safe-reboot --check  … 判定のみ表示し、再起動は絶対にしない（テスト/監査用）
#
set -u

AUDIT="/Users/eggcamera/Library/Logs/eggcamera-reboot-audit.log"
now() { date '+%Y-%m-%dT%H:%M:%S%z'; }

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# --- 呼び出し元の祖先プロセスチェーンを PPID で遡って収集 ---
chain=""
pid=$PPID
i=0
while [[ "$pid" -gt 1 && "$i" -lt 25 ]]; do
  info="$(ps -o ppid=,comm= -p "$pid" 2>/dev/null)"
  [[ -z "${info//[[:space:]]/}" ]] && break
  read -r ppid comm <<< "$info"
  [[ -z "$ppid" ]] && break
  chain="${chain}${comm:t} <- "
  pid="$ppid"
  ((i++))
done
chain="${chain}launchd[1]"

# --- 禁止祖先（Claude Code / IDE GUI）の検出 ---
DENY_RE='claude|Code Helper|Electron|Cursor|VSCodium'
if print -r -- "$chain" | grep -qiE "$DENY_RE"; then
  verdict="DENY"
else
  verdict="ALLOW"
fi

printf '%s [%s]%s uid=%s chain: %s\n' \
  "$(now)" "$verdict" "$([[ $CHECK_ONLY -eq 1 ]] && print -n ' (check)')" "$(id -u)" "$chain" \
  >> "$AUDIT" 2>/dev/null

if [[ "$verdict" == "DENY" ]]; then
  print -r -- "🛑 eggcamera-safe-reboot: Claude/IDE 由来の Mac 再起動はブロックされました。" >&2
  print -r -- "   呼び出し元チェーン: $chain" >&2
  print -r -- "   → Mac再起動は Slack '/egg-reboot mac confirm'、または人手で 'sudo /sbin/shutdown -r now'（要パスワード）で実行してください。" >&2
  exit 87
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  print -r -- "✅ ALLOW（正規の呼び出し元）: $chain"
  print -r -- "   --check モードのため、実際の再起動は行いません。"
  exit 0
fi

print -r -- "$(now) Mac mini を再起動します（呼び出し元: $chain）"
sync
exec /sbin/shutdown -r now
