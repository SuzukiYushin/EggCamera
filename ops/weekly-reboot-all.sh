#!/bin/zsh
# 週次再起動（スクリプトベース／Claude非依存）。
# 対象: iPhone と Mac mini。iPadは2026-08-06〜対象外（キオスクが落ちると人手復旧が要るため）。
#       iPadも再起動したい場合は REBOOT_IPAD=1 を付ける。
# 周期: launchd(com.eggcamera.reboot-test, 毎日15:00発火) ＋ 下の周期ゲート(≥40h)で実質2日毎。
#       手動で即時実行したい場合は FORCE_REBOOT=1 を付けてゲートを無視する。
# 流れ: 前リフレッシュ値ログ → iPad疎通確認 → iPhone再起動+カメラ復帰 →
#        肥大ログtruncate → Mac mini再起動（最後・このスクリプトもここで終了）。
# Mac復帰後の復旧確認・後リフレッシュ値は post-boot-verify / post-boot-claude（launchd）が自動実行。
# 必要権限: iPad/iPhoneはdevicectl/cfgutil(sudo不要)、Macは /etc/sudoers.d/eggcamera-shutdown（パスワードレス）。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

LOG="$HOME/Library/Logs/eggcamera-weekly-reboot.log"
IPAD_UDID="00008132-001E2934019A401C"
TOKEN=$(grep -E "^ADMIN_TOKEN=" /Users/eggcamera/EggCamera/EggCameraNode/.env 2>/dev/null | cut -d= -f2)
MARK="http://127.0.0.1:3000/api/test-report"
sz() { stat -f%z "$1" 2>/dev/null || echo 0; }
STATE="$HOME/Library/Logs/eggcamera-reboot-test.last"   # 周期ゲート: 前回Mac再起動を実行した時刻(epoch)
MIN_H=${REBOOT_TEST_MIN_INTERVAL_H:-40}                 # これ未満の経過なら実行しない(毎日15:00発火→実質2日毎)

# ── 出力先（2026-08-06追加）───────────────────────────────
# 従来は全出力をログへ流すだけだったため、手動実行すると端末に何も出ず
# 「動いているのか固まっているのか／そもそも走ったのか」が分からなかった。
# ログは従来どおり残しつつ、端末(TTY)から実行したときは同じ内容を画面にも流す。
if [ -t 1 ]; then
  exec > >(tee -a "$LOG") 2>&1
else
  exec >> "$LOG" 2>&1
fi

# 経過時間つきの進捗表示。step は画面とログの両方、prog は画面だけ(同じ行を上書き)。
# prog は /dev/tty へ直接書くので、tee でパイプされていても、子スクリプトからでも効く。
# launchd 実行時は /dev/tty が無く書き込みが失敗するだけなので、ログは汚れない。
T0=$(date +%s)
el()   { local s=$(( $(date +%s) - T0 )); printf '%02d:%02d' $((s/60)) $((s%60)); }
step() { echo "[$(el)] ▶ $*"; }
prog() { printf '\r\033[K      … %s' "$*" >/dev/tty 2>/dev/null || true; }
prog_end() { printf '\r\033[K' >/dev/tty 2>/dev/null || true; }
# ── 周期ゲート: launchdは「2日毎」を表現できないため毎日発火＋ここで間引く。
#    stampはMac再起動を実行した時のみ更新→中止/スキップ回は翌日15:00に自動リトライされる。
if [ "${FORCE_REBOOT:-0}" != 1 ]; then
  last=$(cat "$STATE" 2>/dev/null || echo 0)
  elapsed=$(( $(date +%s) - last ))
  if [ "$elapsed" -lt $(( MIN_H * 3600 )) ]; then
    echo "==== $(date '+%F %T') 周期ゲート: 前回Mac再起動から$(( elapsed / 3600 ))h (<${MIN_H}h) → 今回スキップ ===="
    exit 0
  fi
fi
echo "==== $(date '+%F %T') 週次再起動 開始（対象: iPhone + Mac / iPadは対象外）===="
echo "     ログ: $LOG"

# テスト実行中ならスキップ（RemoteXPC競合＋テスト中断回避、次回に持ち越し）。
# 注意: 単純な pgrep は post-boot復旧Claudeのプロンプト本文(多行)を誤検知する。
# 実際の node …ipad-test.js だけを PID単位・claude除外・自己マッチ回避([i]) で判定。
running_ipad_test() {
  local pid cmd
  for pid in $(pgrep -f '[i]pad-test\.js' 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null | tr '\n' ' ')
    case "$cmd" in
      (*dangerously-skip-permissions*) continue ;;
      (*node*ipad-test.js*) return 0 ;;
    esac
  done
  return 1
}
if running_ipad_test; then
  echo "テストセッション実行中→今回はスキップ"; echo "==== end (skipped) ===="; exit 0
fi

# DEPLOY-MARKER
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-reboot): 週次再起動開始(iPhone+Mac、iPadは対象外)。撮影断・無応答は本作業由来で異常ではない。"}' >/dev/null 2>&1

# ── 前リフレッシュ値（再起動で解消される蓄積の記録）──
step "[1/5] 再起動前の値を記録中"
echo "[pre] metrics = $(curl -s -m 5 -H "X-Admin-Token: $TOKEN" http://127.0.0.1:3000/api/admin/metrics 2>/dev/null)"
echo "[pre] disk    = $(curl -s -m 5 -H "X-Admin-Token: $TOKEN" http://127.0.0.1:3001/api/admin/disk 2>/dev/null)"
echo "[pre] logs    = iproxy:$(sz "$HOME/Library/Logs/eggcamera-iproxy.out") appium:$(sz "$HOME/Library/Logs/eggcamera-appium.out") tmpappium:$(sz /tmp/appium.log)"
echo "[pre] swap    = $(sysctl -n vm.swapusage 2>/dev/null) tmpdir:$(du -sk /tmp 2>/dev/null | cut -f1)KB"

# ── iPhone 再起動（iPadは疎通確認のみ・検証済みスクリプトを再利用）──
# 終了ステータスを必ず受け取る。前半が「再起動できていない」と判断したらMacは再起動しない。
step "[2/5] iPhone再起動（iPad疎通確認つき）— 数分かかります"
/Users/eggcamera/EggCamera/ops/reboot-all-test.sh
front_rc=$?
step "[2/5] 完了 rc=$front_rc"

# ── ★ゲート: iPad疎通/iPhone復帰を確認してからのみ Mac を再起動する ──
# iPadは再起動対象外(2026-08-06〜)だが、Mac再起動でキオスクが落ちた際に生死を切り分けられるよう
# 「再起動前に疎通していた」ことは記録しておく。iPhoneは再起動明けのため最大180秒リトライ。
step "[3/5] ゲート判定（iPad疎通 / iPhoneカメラ復帰を最大180秒待つ）"
ipad_ok=0; iphone_ok=0; fcode=000
for g in $(seq 1 36); do
  # iPad検出は `list devices` がlaunchd環境で誤陰性のため UDID指定の device info(tunnelState) を使う
  [ "$ipad_ok" != 1 ] && xcrun devicectl device info details --device "$IPAD_UDID" 2>/dev/null | grep -qiE "tunnelState:[[:space:]]*connected" && ipad_ok=1
  [ "$iphone_ok" != 1 ] && { fcode=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://127.0.0.1:8080/frame 2>/dev/null || echo 000); [ "$fcode" = 200 ] && iphone_ok=1; }
  [ "$ipad_ok" = 1 ] && [ "$iphone_ok" = 1 ] && break
  prog "ゲート待機 $((g*5))/180秒  iPad疎通=$ipad_ok  frame=$fcode"
  sleep 5
done
prog_end
echo "[gate] 前半rc=$front_rc / iPad疎通=$ipad_ok（再起動対象外） / iPhoneカメラ(frame)=$iphone_ok"

# Mac再起動の可否はiPadでは判定しない。再起動していない以上、疎通不可でも
# 「本ルーティンが壊した」わけではないため記録に留める。
[ "$ipad_ok" = 1 ] || echo "⚠ iPad疎通なし（本ルーティンは再起動していない。別要因のため記録のみ）"

# ★ front_rc は必須条件。frame=200 だけで判断すると、再起動が失敗して端末が一度も落ちて
#   いない場合に「復帰した」と誤合格する（2026-08-06に実地で確認したバグ）。
if [ "$front_rc" != 0 ] || [ "$iphone_ok" != 1 ]; then
  echo "⚠ iPhoneの再起動/復帰を確認できず（前半rc=$front_rc frame復帰=$iphone_ok） → Mac mini 再起動を中止（安全のため）"
  curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
    --data "{\"level\":\"alert\",\"text\":\"DEPLOY-MARKER(weekly-reboot): iPhone再起動未確認(前半rc=$front_rc frame=$iphone_ok)のためMac再起動を中止。要確認。\"}" >/dev/null 2>&1
  echo "==== $(date '+%F %T') 中止（iPhone再起動未確認・所要 $(el)） ===="
  echo "     ヒント: iPhoneがdevicectlから見えているか  xcrun devicectl device info details --device <id> | grep tunnelState"
  exit 1
fi

# ── 肥大ログを truncate（再起動では消えない）──
step "[4/5] 肥大ログを truncate"
for f in "$HOME/Library/Logs/eggcamera-iproxy.out" "$HOME/Library/Logs/eggcamera-appium.out" "/tmp/appium.log"; do
  [ -f "$f" ] && : > "$f" && echo "[truncate] $f ($(sz "$f") bytes)"
done

# ── Mac mini 再起動（iPad/iPhone復帰確認済みなので実行）──
date +%s > "$STATE"   # 周期ゲートstamp: 実際にMac再起動へ進む時のみ更新
echo "==== $(date '+%F %T') iPad/iPhone復帰OK → Mac mini 再起動 → 復旧はpost-boot-verify/claudeが確認 ===="
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(weekly-reboot): iPad/iPhone復帰確認済→Mac mini再起動。launchd自動復旧をpost-bootが確認する。"}' >/dev/null 2>&1
sync
# ガードレール経由で再起動（祖先検査付きラッパー）。weekly は launchd 配下なので許可される。
# Claude/IDE 由来だと必ず DENY される（2026-06-18の事故を受けた恒久策・正常動作）。
step "[5/5] Mac mini を再起動（ガードレール経由）"
sudo -n /Library/EggCamera/bin/eggcamera-safe-reboot
