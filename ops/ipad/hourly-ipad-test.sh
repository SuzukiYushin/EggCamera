#!/bin/zsh
# 毎時0分に iPad の6サイクル運用テスト(ipad-test.js)を1セッション実行する。
# launchd(com.eggcamera.hourly-test, StartCalendarInterval Minute=0)から起動される。
#
# 設計方針（既存opsの流儀に合わせる）:
#   - 前提チェック(node/appium/iPadレジストリ)を満たす時だけ実行。usbmux脱落は自動復旧を試行。
#   - 多重起動防止(前の回が走行中ならスキップ)・メンテ中スキップ(週次チェーンとの衝突回避)。
#   - 開始/終了で DEPLOY-MARKER を /api/test-report に投稿(監視の誤検知防止)。
#   - 失敗(失敗>0 or 異常終了 or 前提NG)のみ Slack 通知。正常時の毎時通知はしない(スパム防止)。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

IPAD="00008132-001E2934019A401C"
NODE="/opt/homebrew/bin/node"
TEST_JS="/Users/eggcamera/EggCamera/EggCameraNode/tools/ipad-test.js"
RECOVER="/Users/eggcamera/EggCamera/ops/ipad/recover-ipad-usbmux.sh"
LOGDIR="/Users/eggcamera/Library/Logs"
MAIN_LOG="$LOGDIR/eggcamera-hourly-test.log"
SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"

log() { echo "[$(date '+%F %T')] $*" >> "$MAIN_LOG"; }

post_marker() { # level text
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data "$(printf '{"level":"%s","text":"DEPLOY-MARKER(hourly-test): %s"}' "$1" "$2")" >/dev/null 2>&1
}

# アクション種別タグ（受信者が「何をすべきか」を一目で判断できるよう先頭に出す）
slack_tag() { # action(none/fix/restart/investigate) → タグ文字列
  case "$1" in
    none)    echo ":white_check_mark: *通知：対処不要*" ;;
    fix)     echo ":wrench: *要修正：コード/設定を確認*" ;;
    restart) echo ":electric_plug: *要再起動／物理操作*" ;;
    *)       echo ":mag: *要調査：原因を確認*" ;;
  esac
}
notify_slack() { # action text
  [ -f "$SLACK_ENV" ] || return 0
  local url; url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
  [ -n "$url" ] || return 0
  curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":"%s\n*hourly-test* %s"}' "$(slack_tag "$1")" "$2")" "$url" >/dev/null 2>&1
}

skip() { # level action text  — 実行せず終了
  log "SKIP($1): $3"
  post_marker "$1" "$3"
  [ "$1" = "alert" ] && notify_slack "$2" "$3"
  exit 0
}

# ── 0) 多重起動防止: 前の回(または手動実行)がまだ走っていればスキップ ──
# node インタプリタが実際に ipad-test.js を実行しているプロセスだけを数える。
# 二つの落とし穴を回避する(いずれも2026-06-21に踏んだ):
#   (1) pgrep -f "node.*ipad-test.js" 方式は、この起動コマンド文字列を引数に抱える別プロセス
#       (復旧Claudeのプロンプト/SSH引数, 監視スクリプト)にも誤マッチ → 常駐プロセスが居る限り
#       毎時テストが永久スキップされる。
#   (2) ps -o comm は16文字で切り詰められ "/opt/homebrew/bin/node" が "/opt/homebrew/bi" に
#       なり node 判定が外れる(本物の多重起動も検出できなくなる)。
# → command(フル)の第1トークン=実行ファイルの basename が node のプロセスだけを数える。
if ps -axww -o command= | awk '{n=split($1,a,"/")} a[n]=="node" && index($0,"tools/ipad-test.js")>0 {found=1} END{exit found?0:1}'; then
  skip info none "前セッションが走行中のためスキップ(重複起動防止)"
fi

# ── 1) メンテナンス中はスキップ(週次再起動/メンテと衝突させない) ──
mode=$(curl -s -m 5 http://127.0.0.1:3000/api/mode 2>/dev/null)
if echo "$mode" | grep -q '"maintenance":true'; then
  skip info none "メンテナンスモード中のためスキップ"
fi

# ── 2) サービス前提: node:3000 と appium:4723 が応答するか ──
ncode=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/ 2>/dev/null)
acode=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:4723/status 2>/dev/null)
if [ "$ncode" != "200" ] || [ "$acode" != "200" ]; then
  skip alert restart "サービス未復帰でスキップ(node=$ncode appium=$acode)"
fi

# ── 3) iPad が Appium公式トンネルレジストリ:42314 に居るか。落ちていたら自動復旧を試行 ──
reg=$(curl -s -m 3 http://localhost:42314/remotexpc/tunnels 2>/dev/null)
if ! echo "$reg" | grep -q "$IPAD"; then
  log "iPad未在籍 → recover-ipad-usbmux.sh で自動復旧を試行"
  [ -x "$RECOVER" ] && "$RECOVER" >> "$MAIN_LOG" 2>&1
  # 復旧後にレジストリ反映を最大40秒待つ
  for i in $(seq 1 40); do
    reg=$(curl -s -m 2 http://localhost:42314/remotexpc/tunnels 2>/dev/null)
    echo "$reg" | grep -q "$IPAD" && break
    sleep 1
  done
fi
if ! echo "$reg" | grep -q "$IPAD"; then
  skip alert restart "iPadがトンネルレジストリ:42314に居ない(usbmux脱落の可能性, 自動復旧失敗)→要USB-C抜き差し"
fi

# ── 4) 実行 ──
RUN_LOG="$LOGDIR/eggcamera-hourly-test-$(date '+%Y%m%d-%H%M').log"
log "=== 毎時テスト開始 → $RUN_LOG ==="
post_marker info "毎時6サイクルテスト開始(node=$ncode appium=$acode iPad在籍)"

"$NODE" "$TEST_JS" > "$RUN_LOG" 2>&1
rc=$?

# ── 5) 結果集計＋報告 ──
summary_line=$(grep 'セッション完了:' "$RUN_LOG" | tail -1)
if [ -z "$summary_line" ]; then
  txt="異常終了(rc=$rc, セッション完了行なし)。末尾: $(tail -1 "$RUN_LOG" 2>/dev/null | cut -c1-120)"
  log "$txt"; post_marker alert "$txt"; notify_slack investigate "$txt"; exit 0
fi

# 「=== セッション完了: 完了4 フォルトOK0 スキップ0 失敗2 / 6サイクル ===」から数値抽出
fails=$(echo "$summary_line" | grep -oE '失敗[0-9]+' | grep -oE '[0-9]+')
counts=$(echo "$summary_line" | sed -E 's/.*完了/完了/; s/ ===.*//')
log "完了: $counts (rc=$rc)"
if [ "${fails:-0}" -gt 0 ] || [ "$rc" -ne 0 ]; then
  txt="毎時テスト完走(要確認): $counts"
  post_marker alert "$txt"; notify_slack investigate "$txt"
else
  post_marker info "毎時テスト正常完走: $counts"
fi
exit 0
