#!/bin/zsh
#
# install-reboot-guardrail.sh — Mac mini 再起動ガードレールのインストーラ（要 root）
#
#   sudo /Users/eggcamera/EggCamera/ops/install-reboot-guardrail.sh
#
# 行うこと:
#   1) ラッパー eggcamera-safe-reboot を root 所有の保護ディレクトリ
#      /Library/EggCamera/bin/ に設置（eggcamera ユーザーは書換不可）
#   2) /etc/sudoers.d/eggcamera-reboot を visudo 検証のうえ差し替え
#      （/sbin/shutdown 直叩きの NOPASSWD を廃止し、ラッパーのみ許可）
#   3) 結果を表示
#
# 冪等・可逆: 既存 sudoers はタイムスタンプ付きで .bak にバックアップ。
#
set -euo pipefail

REPO="/Users/eggcamera/EggCamera"
BIN_DIR="/Library/EggCamera/bin"
WRAPPER_SRC="$REPO/ops/eggcamera-safe-reboot.sh"
WRAPPER_DST="$BIN_DIR/eggcamera-safe-reboot"
SUDOERS_SRC="$REPO/ops/sudoers.d/eggcamera-reboot"
SUDOERS_DST="/etc/sudoers.d/eggcamera-reboot"

if [[ "$(id -u)" -ne 0 ]]; then
  print -r -- "❌ root で実行してください:  sudo $0"
  exit 1
fi
[[ -f "$WRAPPER_SRC"  ]] || { print -r -- "❌ 見つかりません: $WRAPPER_SRC"; exit 1; }
[[ -f "$SUDOERS_SRC"  ]] || { print -r -- "❌ 見つかりません: $SUDOERS_SRC"; exit 1; }

print -r -- "1) ラッパーを root 所有ディレクトリに設置"
mkdir -p "$BIN_DIR"
chown root:wheel /Library/EggCamera "$BIN_DIR"
chmod 755 /Library/EggCamera "$BIN_DIR"
install -o root -g wheel -m 0755 "$WRAPPER_SRC" "$WRAPPER_DST"
print -r -- "   → $WRAPPER_DST （root:wheel 0755）"

print -r -- "2) sudoers を visudo 検証してから差し替え"
if [[ -f "$SUDOERS_DST" ]]; then
  bak="${SUDOERS_DST}.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$SUDOERS_DST" "$bak"
  print -r -- "   既存をバックアップ: $bak"
fi
tmp="$(mktemp)"
cp "$SUDOERS_SRC" "$tmp"
chmod 0440 "$tmp"
if visudo -cf "$tmp" >/dev/null; then
  install -o root -g wheel -m 0440 "$SUDOERS_SRC" "$SUDOERS_DST"
  print -r -- "   → $SUDOERS_DST （visudo 検証 OK / root:wheel 0440）"
else
  print -r -- "❌ sudoers 構文エラー。中止します（既存は変更していません）。"
  rm -f "$tmp"; exit 1
fi
rm -f "$tmp"

print -r -- ""
print -r -- "2.5) 旧『/sbin/shutdown 直叩き』NOPASSWD ファイルを無効化（ガードレールの穴を塞ぐ）"
LEGACY="/etc/sudoers.d/eggcamera-shutdown"
if [[ -f "$LEGACY" ]]; then
  cp -p "$LEGACY" "/Library/EggCamera/$(basename "$LEGACY").removed.$(date +%Y%m%d%H%M%S)"
  rm -f "$LEGACY"
  print -r -- "   削除: $LEGACY （バックアップを /Library/EggCamera/ に保存）"
else
  print -r -- "   $LEGACY は無し（既に無効化済み or 未作成）"
fi
# 念のため、他に /sbin/shutdown を直接 NOPASSWD しているファイルが残っていないか走査
stray="$(grep -rlnE 'NOPASSWD:.*/sbin/(shutdown|reboot|halt)' /etc/sudoers /etc/sudoers.d 2>/dev/null | grep -v "^$SUDOERS_DST$" || true)"
if [[ -n "$stray" ]]; then
  print -r -- "   ⚠ まだ /sbin/shutdown 等を直接許可するファイルがあります → 要確認:"
  print -r -- "$stray" | sed 's/^/      /'
else
  print -r -- "   ✅ /sbin/shutdown 直叩きの NOPASSWD は他に残っていません"
fi

print -r -- ""
print -r -- "3) 新コード反映のため admin(:3001) と bot を再起動（カメラ node:3000 は無関係なので触らない）"
MARK_URL="http://127.0.0.1:3000/api/test-report"
curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(reboot-guardrail): 再起動ガードレール設置→admin/bot再起動。Claude/IDE由来の自律shutdownをブロック。本操作由来の管理API瞬断は異常ではない。"}' >/dev/null 2>&1 || true
UID_GUI="$(stat -f%u /dev/console 2>/dev/null || echo 501)"
for svc in com.eggcamera.admin com.eggcamera.bot; do
  if launchctl kickstart -k "gui/${UID_GUI}/${svc}" 2>/dev/null; then
    print -r -- "   reloaded: $svc"
  else
    print -r -- "   ⚠ reload skipped (手動で: launchctl kickstart -k gui/${UID_GUI}/${svc}): $svc"
  fi
done
# admin(:3001) の復帰待ち（最大30秒）
for i in {1..15}; do
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:3001/api/admin/disk -H "X-Admin-Token: $(grep -E '^ADMIN_TOKEN=' "$REPO/EggCameraNode/.env" 2>/dev/null | cut -d= -f2-)" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] && { print -r -- "   admin(:3001) 復帰OK (HTTP $code)"; break; }
  sleep 2
done
curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(reboot-guardrail): admin/bot再起動完了。ガードレール有効。"}' >/dev/null 2>&1 || true

print -r -- ""
print -r -- "4) 確認: eggcamera の NOPASSWD 一覧（/sbin/shutdown が消え、ラッパーのみになっていれば成功）"
sudo -u eggcamera sudo -n -l 2>/dev/null | grep -iE "nopasswd" || true
print -r -- ""
print -r -- "✅ 完了。"
print -r -- "   ・Claude/IDE からの 'sudo -n .../eggcamera-safe-reboot' は祖先検査で拒否（exit 87）"
print -r -- "   ・'sudo -n /sbin/shutdown -r now' はパスワード要求で失敗（自律再起動を物理ブロック）"
print -r -- "   ・正規経路（Slack /egg-reboot mac confirm・admin・weekly launchd）は維持"
print -r -- "   監査ログ: /Users/eggcamera/Library/Logs/eggcamera-reboot-audit.log"
