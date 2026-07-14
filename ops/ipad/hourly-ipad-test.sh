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
# iPadが不通のときの代替: 本番実パスのAPI E2E(Safari不要。3枚撮影→compose→confirm→R2)。
E2E_JS="/Users/eggcamera/EggCamera/EggCameraNode/tools/prod-e2e.js"
E2E_CYCLES="${E2E_CYCLES:-3}"
# iPadの物理対応リマインダは間引く(30分毎のSlack連打を防ぐ)。既定6時間に1回。
IPAD_DOWN_STAMP="/Users/eggcamera/Library/Logs/eggcamera-ipad-down-notified.stamp"
IPAD_REMIND_SEC="${IPAD_REMIND_SEC:-21600}"
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

# iPadの物理対応リマインダ。毎枠鳴らすとSlackが埋まるので IPAD_REMIND_SEC に1回だけ。
# iPad復帰時にスタンプを消すので、次の障害では即座に鳴る。
remind_ipad_down() { # text
  local now last
  now=$(date +%s)
  last=0; [ -f "$IPAD_DOWN_STAMP" ] && last=$(cat "$IPAD_DOWN_STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -ge "$IPAD_REMIND_SEC" ]; then
    notify_slack restart "$1"
    echo "$now" > "$IPAD_DOWN_STAMP"
  fi
}

# iPadが使えない間の代替テスト。キオスクUI(Safari操作)以外＝本番実パスの
# 撮影→サーバ合成→決定→uploadWorker→R2→DLページ を回す。テストを止めない方が
# バックエンドの退行を拾えるため、SKIPではなくこちらへフォールバックする。
run_api_fallback() { # reason
  log "iPad不通 → API E2E(${E2E_CYCLES}サイクル)へフォールバック: $1"
  post_marker info "iPad不通のためAPI E2Eへフォールバック(${E2E_CYCLES}サイクル)"
  local out rc summary
  out=$("$NODE" "$E2E_JS" --cycles "$E2E_CYCLES" 2>&1); rc=$?
  echo "$out" >> "$MAIN_LOG"
  summary=$(echo "$out" | grep 'E2E完了' | tail -1)
  [ -z "$summary" ] && summary="出力なし(rc=$rc): $(echo "$out" | tail -1 | cut -c1-120)"
  if [ "$rc" -ne 0 ]; then
    log "API E2E 失敗: $summary"
    post_marker alert "API E2E 失敗(iPad不通中の代替テスト): $summary"
    notify_slack investigate "API E2E 失敗(iPad不通中の代替テスト): $summary"
  else
    log "API E2E 正常: $summary"
    post_marker info "API E2E 正常(iPad不通中の代替テスト): $summary"
  fi
  remind_ipad_down "iPadが不通のまま(バックエンドはAPI E2Eで継続検証中)。復旧には物理操作が要る: $1"
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

# ── 0.5) iPad夜間スリープ中はスキップ(USB切断期間の省電力運用・2026-07-11〜) ──
# ipad-sleep.sh(23:30)がフラグを作成し、ipad-wake.sh(8:30)が削除する。
if [ -f "/Users/eggcamera/EggCamera/ops/ipad/.ipad-sleeping" ]; then
  skip info none "iPad夜間スリープ中のためスキップ(USB切断期間の省電力運用)"
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

# ── 3) iPad 到達性の前提チェック ──
# USB切断期間のWi-Fi経由モード(2026-07-11): フラグファイルがあれば、USBトンネル
# レジストリ(:42314)ではなくWi-Fi WDA構成(xcodebuild+フォワーダ)を確認/自動復旧する。
# 前提: iPad EnableWifiConnections=true 設定済み(usbmuxdにNetwork登録)。
# 解除方法: USB復旧後にフラグファイルを削除すれば従来のUSB経路に戻る。
WIFI_MODE_FLAG="/Users/eggcamera/EggCamera/ops/ipad/.wda-wifi-mode"
if [ -f "$WIFI_MODE_FLAG" ]; then
  if /Users/eggcamera/EggCamera/ops/ipad/wda-wifi-recovery.sh >> "$MAIN_LOG" 2>&1; then
    export IPAD_TEST_WDA_URL="http://127.0.0.1:18100"
    # バッテリー温存(2026-07-12): Wi-Fiモード中は1サイクル×30分毎(launchdにMinute=30追加済)。
    # 画面オン時間 約20分/時→7分/時。USB復旧後は6サイクル×毎時に自動復帰(フラグ削除+plist戻し)。
    export CYCLES=1
    log "Wi-Fiモード: WDA=$IPAD_TEST_WDA_URL CYCLES=$CYCLES (USBトンネルチェックはスキップ)"
  else
    run_api_fallback "Wi-Fiモード: WDA構成の自動復旧失敗(iPad電源/Wi-Fi要確認)"
  fi
else
  # 従来: iPad が Appium公式トンネルレジストリ:42314 に居るか。落ちていたら自動復旧を試行
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
    run_api_fallback "iPadがトンネルレジストリ:42314に居ない(usbmux脱落。要USB-C抜き差し)"
  fi
fi

# ── 4) 実行 ──
# Wi-Fiモード時の省電力(2026-07-12): USB給電なし=バッテリー運用のため、日中も
# テスト時以外は画面ロック。テスト前にunlock・テスト後(下の5節末尾)にlockする。
wda_screen() { # lock|unlock → 0=成功
  # 注意: WDA生レスポンスは '"value" : true' とスペース入りのためERE+スペース許容で判定
  local want; [ "$1" = "lock" ] && want='"value"[[:space:]]*:[[:space:]]*true' || want='"value"[[:space:]]*:[[:space:]]*false'
  curl -s -m 10 -X POST "http://127.0.0.1:18100/wda/$1" -H "Content-Type: application/json" -d "{}" >/dev/null
  for i in $(seq 1 12); do
    sleep 5
    curl -s -m 10 "http://127.0.0.1:18100/wda/locked" | grep -qE "$want" && return 0
    curl -s -m 10 -X POST "http://127.0.0.1:18100/wda/$1" -H "Content-Type: application/json" -d "{}" >/dev/null
  done
  return 1
}
if [ -f "$WIFI_MODE_FLAG" ]; then
  if wda_screen unlock; then log "テスト前unlock成功(省電力運用)"; else log "⚠ unlock失敗→そのまま実行を試行"; fi
fi

rm -f "$IPAD_DOWN_STAMP"   # ここに来た＝iPad在籍。次に落ちたら即リマインドできるようにする
RUN_LOG="$LOGDIR/eggcamera-hourly-test-$(date '+%Y%m%d-%H%M').log"
log "=== 毎時テスト開始 → $RUN_LOG ==="
post_marker info "毎時6サイクルテスト開始(node=$ncode appium=$acode iPad在籍)"

"$NODE" "$TEST_JS" > "$RUN_LOG" 2>&1
rc=$?

# テスト後は即ロック(Wi-Fiモード省電力。結果集計はロック後でも問題ない)
if [ -f "$WIFI_MODE_FLAG" ]; then
  if wda_screen lock; then log "テスト後lock成功(省電力運用)"; else log "⚠ テスト後lock失敗(画面オンのまま)"; fi
fi

# ── 5) 結果集計＋報告 ──
summary_line=$(grep 'セッション完了:' "$RUN_LOG" | tail -1)
if [ -z "$summary_line" ]; then
  txt="異常終了(rc=$rc, セッション完了行なし)。末尾: $(tail -1 "$RUN_LOG" 2>/dev/null | cut -c1-120)"
  log "$txt"; post_marker alert "$txt"; notify_slack investigate "$txt"; exit 0
fi

# 「=== セッション完了: 完了4 フォルトOK0 スキップ0 失敗2 / 6サイクル ===」から数値抽出
fails=$(echo "$summary_line" | grep -oE '失敗[0-9]+' | grep -oE '[0-9]+')
# 完了数。Appiumのセッション起動失敗などで1サイクルも走らないと「完了0 失敗0 rc=0」となり、
# 従来はこれを正常完走として無音で流していた(2026-07-12夜〜13未明に6枠を取りこぼした)。
done_n=$(echo "$summary_line" | grep -oE '完了[0-9]+' | head -1 | grep -oE '[0-9]+')
counts=$(echo "$summary_line" | sed -E 's/.*完了/完了/; s/ ===.*//')
log "完了: $counts (rc=$rc)"
if [ "${done_n:-0}" -eq 0 ] && [ "${fails:-0}" -eq 0 ]; then
  txt="毎時テストが1サイクルも走っていない(完了0/失敗0: セッション起動失敗の疑い): $counts"
  log "$txt"; post_marker alert "$txt"; notify_slack investigate "$txt"; exit 0
fi
if [ "${fails:-0}" -gt 0 ] || [ "$rc" -ne 0 ]; then
  txt="毎時テスト完走(要確認): $counts"
  post_marker alert "$txt"; notify_slack investigate "$txt"
else
  post_marker info "毎時テスト正常完走: $counts"
fi
exit 0
