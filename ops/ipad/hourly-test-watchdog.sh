#!/bin/zsh
# 毎時50分に launchd(com.eggcamera.hourly-test-watchdog)から起動。
# 直前(=同じ"時"の HH:00 開始)の毎時テスト枠が「実行され・完走し・成功したか」を
# MAIN_LOG から検査する二重チェック watchdog。
#
# 目的: hourly-ipad-test.sh ラッパー内蔵の通知は「テストが実行された場合」しか出ない。
#   そもそも未実行/全スキップ/ラッパー即死/launchd未発火 という"静かな停止"は捕捉できない。
#   実際 2026-06-21 に「復旧Claude常駐 → ガード pgrep 誤マッチ → 7サイクル連続スキップ」で
#   毎時テストが無音のまま止まる事故が起きた。本watchdogはその穴を毎時50分に塞ぐ。
#
# 通知方針: 異常時のみ Slack + /api/test-report に alert(正常時は WD_LOG にログのみ=スパム防止)。
# 稼働時間帯: launchd 側で毎時テストと同じ時間帯(0-2,5-14,17-23時)の Minute=50 のみ発火させる
#   ため、テストを走らせない時間帯(3,4,15,16時)を「未実行」と誤検知することはない。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

LOGDIR="/Users/eggcamera/Library/Logs"
MAIN_LOG="$LOGDIR/eggcamera-hourly-test.log"
WD_LOG="$LOGDIR/eggcamera-hourly-test-watchdog.log"
SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"

log() { echo "[$(date '+%F %T')] $*" >> "$WD_LOG"; }

post_marker() { # level text
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data "$(printf '{"level":"%s","text":"DEPLOY-MARKER(hourly-watchdog): %s"}' "$1" "$2")" >/dev/null 2>&1
}
notify_slack() { # text（watchdogの通知は常に「要調査：原因を確認」=まずログ/launchd状態を見る）
  [ -f "$SLACK_ENV" ] || return 0
  local url; url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
  [ -n "$url" ] || return 0
  curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":":mag: *[プログラム点検] hourly-watchdog* — 要調査：原因を確認: %s"}' "$1")" "$url" >/dev/null 2>&1
}
alert() { # text
  log "ALERT: $1"; post_marker alert "$1"; notify_slack "$1"
}
notify_slack_action() { # text（自動復旧を「実行した」お知らせ。要調査ではなく対応済みの情報）
  [ -f "$SLACK_ENV" ] || return 0
  local url; url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
  [ -n "$url" ] || return 0
  curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":":robot_face: *[自動復旧] hourly-watchdog* — %s"}' "$1")" "$url" >/dev/null 2>&1
}

# ── 自動復旧（既知で安全な障害の自動修正） ─────────────────────────────────
# 検知だけでなく、原因が「既知で安全に直せるもの」なら自動で修正する。
# 第1弾: iPhone撮影の in-flight スタック / capture_timeout → iphone.sh restart。
IPHONE_SH="/Users/eggcamera/EggCamera/EggCameraIPhone/iphone.sh"
RECOVERY_STATE="/tmp/eggcamera-capture-recovery.state"
RECOVERY_COOLDOWN=2400  # 40分: 直近に復旧済みでまだ壊れているなら自動ループせず人へ
ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' /Users/eggcamera/EggCamera/EggCameraNode/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\'' ')

# 撮影プローブ: test-capture を叩いて健全/スタック/node停止 を判定して echo する。
capture_probe() {
  local r; r=$(curl -s -m 30 -X POST -H "X-Admin-Token: $ADMIN_TOKEN" http://127.0.0.1:3000/api/admin/test-capture 2>/dev/null)
  if   echo "$r" | grep -q '"photoId"'; then echo ok
  elif [ -z "$r" ];                     then echo node-down
  else                                       echo stuck
  fi
}

# 失敗検知時に呼ぶ。撮影スタックなら自動復旧を実行して 0、撮影が原因でなければ 1 を返す。
auto_recover_capture() {
  local p; p=$(capture_probe)
  case "$p" in
    ok)        log "自動復旧: 撮影プローブ健全 → 撮影層は原因でない(別要因)"; return 1 ;;
    node-down) log "自動復旧: 撮影プローブ無応答 → node停止疑い(撮影層でなく別系統)";    return 1 ;;
  esac
  # p=stuck: 撮影スタック確定
  log "自動復旧: 撮影プローブ=stuck → 撮影 in-flight スタック検知"
  local now last; now=$(date +%s); last=$(cat "$RECOVERY_STATE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$RECOVERY_COOLDOWN" ]; then
    alert "撮影スタックが自動復旧後も継続(前回復旧 $(((now-last)/60))分前)。iphone.sh restartで直らず=要人手(iphone.sh run/本体再起動/署名確認)。"
    return 0
  fi
  echo "$now" > "$RECOVERY_STATE"
  post_marker info "撮影 in-flight スタックを検知 → iphone.sh restart で自動復旧を試行。想定内。"
  log "自動復旧: iphone.sh restart 実行"
  "$IPHONE_SH" restart >> "$WD_LOG" 2>&1
  sleep 12  # カメラ初期化待ち
  if [ "$(capture_probe)" = "ok" ]; then
    log "OK: 撮影スタックを iphone.sh restart で自動復旧(撮影プローブ成功)"
    post_marker info "撮影スタックを iphone.sh restart で自動復旧・撮影プローブ成功。次枠で検証。"
    notify_slack_action "撮影 in-flight スタックを自動復旧しました(iphone.sh restart→撮影プローブ成功)。次の毎時テストで確認します。"
  else
    alert "撮影スタックの自動復旧(iphone.sh restart)に失敗。撮影プローブが依然失敗 → 要人手。"
  fi
  return 0
}

# node が実際に ipad-test.js を実行中か判定。
# ps -o comm は16文字で切り詰められ "/opt/homebrew/bin/node" を取り逃すため、command の
# 第1トークン(実行ファイル)の basename が node かで判定する(claude等は basename≠node で除外)。
test_running() {
  ps -axww -o command= | awk '{n=split($1,a,"/")} a[n]=="node" && index($0,"tools/ipad-test.js")>0 {f=1} END{exit f?0:1}'
}

# 監視対象 = この実行時刻が属する"時"の毎時テスト枠(HH:00開始)。例 11:50起動 → "2026-06-21 11:"。
HOUR_PREFIX="$(date '+%Y-%m-%d %H'):"

if [ ! -f "$MAIN_LOG" ]; then
  alert "MAIN_LOG が存在しない($MAIN_LOG)。毎時テスト基盤が動いていない可能性。"
  exit 0
fi

rows=$(grep -F "$HOUR_PREFIX" "$MAIN_LOG")
done_row=$(echo "$rows" | grep '完了:' | tail -1)

if [ -n "$done_row" ]; then
  # 完走済み。失敗数を確認。
  fails=$(echo "$done_row" | grep -oE '失敗[0-9]+' | grep -oE '[0-9]+')
  if [ "${fails:-0}" -gt 0 ]; then
    # まず既知の安全な原因(撮影スタック)を自動復旧。撮影が原因でなければ従来どおり人へ。
    if auto_recover_capture; then
      log "${HOUR_PREFIX}00枠 失敗${fails} → 撮影層の自動復旧を実行(詳細は上記)。"
    else
      alert "${HOUR_PREFIX}00枠の毎時テストで失敗検出: ${done_row#*] }"
    fi
  else
    log "OK: ${HOUR_PREFIX}00枠 正常完走 → ${done_row#*] }"
  fi
elif [ -z "$rows" ]; then
  # この時間帯の記録が皆無 = launchd未発火 or ラッパー即死。
  alert "${HOUR_PREFIX}00枠の毎時テスト記録が皆無(launchd未発火 or ラッパー即死の疑い)。"
elif echo "$rows" | grep -q '毎時テスト開始' && test_running; then
  # 開始済みで まだ実行中(リトライ等で長引いている)。誤検知回避のため静観。
  log "進行中: ${HOUR_PREFIX}00枠は開始済み・50分時点でなお実行中。次回監視に委ねる。"
else
  # 完了行なし=SKIPのみ/開始したが完走せず死亡。撮影スタックが原因なら自動復旧、それ以外は警告。
  last=$(echo "$rows" | tail -1)
  if auto_recover_capture; then
    log "${HOUR_PREFIX}00枠 未完走 → 撮影層の自動復旧を実行(詳細は上記)。直近行: ${last#*] }"
  else
    alert "${HOUR_PREFIX}00枠の毎時テストが未完走: ${last#*] }"
  fi
fi
exit 0
