#!/bin/zsh
# ═══════════════════════════════════════════════════════════════════════════════
# EggCamera リカバリスクリプト
#
# ログを読んで障害を診断し、正しい優先順位でコンポーネントを再起動する。
# Claude がなくても実行できるよう設計されている。
#
# 使い方:
#   ./recover.sh            # 診断 → 問題があれば自動修復
#   ./recover.sh --status   # 診断のみ（何も変えない）
#   ./recover.sh --dry-run  # 何をするか表示するだけ（実行しない）
#
# 再起動の優先順位:
#   1. Node server (:3000)       ← 全 API の基盤
#   2. Mac Swift app (:8082)     ← iPhone へのトリガー中継
#   3. iPhone アプリ             ← 実際の撮影担当
#   ※ isSending スタック検出時は iPhone → Mac の順で再起動
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")"

# ── 設定 ─────────────────────────────────────────────────────────────────────
NODE_URL="http://localhost:3000"
MAC_PORT=8082
SWIFT_LOG="$(pwd)/data/logs/swift/app.log"
RAW_DIR="$(pwd)/data/raw"
IPHONE_SH="$(pwd)/EggCameraIPhone/iphone.sh"

# 管理API認証（EggCameraNode/.env の ADMIN_TOKEN）。未設定なら空でヘッダ無し。
ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$(pwd)/EggCameraNode/.env" 2>/dev/null | head -1 | tr -d '[:space:]')"
ADMIN_HDR=()
[[ -n "$ADMIN_TOKEN" ]] && ADMIN_HDR=(-H "X-Admin-Token: $ADMIN_TOKEN")

# HEIC がこの分数より古ければ「撮影停止」と判定
STALE_HEIC_MINUTES=10

# テストキャプチャ後この秒数待って HEIC 未着なら失敗
VERIFY_TIMEOUT_SEC=90

# ── フラグ ────────────────────────────────────────────────────────────────────
DRY_RUN=0; STATUS_ONLY=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --status)  STATUS_ONLY=1 ;;
  esac
done

# ── カラー出力 ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YLW='\033[1;33m'; GRN='\033[0;32m'; RST='\033[0m'
fail() { printf "${RED}[FAIL]${RST} %s\n" "$*"; }
warn() { printf "${YLW}[WARN]${RST} %s\n" "$*"; }
ok()   { printf "${GRN}[ OK ]${RST} %s\n" "$*"; }
info() { printf "       %s\n" "$*"; }
step() { printf "\n── %s ──\n" "$*"; }

# dry-run 時は表示のみ、それ以外は実行
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf "${YLW}[DRY-RUN]${RST} %s\n" "$*"
    return 0
  else
    eval "$*"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 診断関数
# ═══════════════════════════════════════════════════════════════════════════════

# Node server が :3000 で応答するか
node_alive() {
  curl -sf -o /dev/null --max-time 5 "${ADMIN_HDR[@]}" "$NODE_URL/api/admin/logs?limit=1"
}

# Mac Swift app が :8082 で POST に 202 を返すか
mac_alive() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST --max-time 5 \
         "localhost:$MAC_PORT/capture" 2>/dev/null)
  [[ "$code" == "202" ]]
}

# isSending スタック検出:
#   Swift ログで "Sending capture command" の後に
#   "accepted / timed out / resetting" が来ていない → スタック
mac_is_stuck() {
  [[ ! -f "$SWIFT_LOG" ]] && return 1
  local last_send last_done
  last_send=$(grep -n "Sending capture command" "$SWIFT_LOG" 2>/dev/null | tail -1 | cut -d: -f1)
  last_done=$(grep -n -E "accepted|timed out|resetting" "$SWIFT_LOG" 2>/dev/null | tail -1 | cut -d: -f1)
  [[ -z "$last_send" ]] && return 1        # send ログなし → 判定不能（スタックでない）
  [[ -z "$last_done" ]] && return 0        # done ログなし → スタック
  [[ "$last_send" -gt "$last_done" ]]      # send が done より後 → スタック
}

# 直近 N 分以内に HEIC ファイルが届いているか
recent_heic_within() {
  local minutes="${1:-$STALE_HEIC_MINUTES}"
  find "$RAW_DIR" -name "*.heic" -mmin -"$minutes" 2>/dev/null | head -1
}

# 最新 HEIC の経過分数（ファイルなければ 9999）
latest_heic_age_min() {
  local f
  f=$(ls -t "$RAW_DIR"/*.heic 2>/dev/null | head -1)
  [[ -z "$f" ]] && echo 9999 && return
  echo $(( ( $(date +%s) - $(stat -f %m "$f") ) / 60 ))
}

# Swift ログで直近 N 行の "Bonjour タイムアウト" / "skipped" の件数
count_swift_pattern() {
  local pattern="$1" lines="${2:-30}"
  [[ ! -f "$SWIFT_LOG" ]] && echo 0 && return
  tail -"$lines" "$SWIFT_LOG" | grep -c "$pattern" 2>/dev/null || echo 0
}

# Node ログから直近の composite 完了を取得
node_last_composite() {
  curl -s --max-time 5 "${ADMIN_HDR[@]}" "$NODE_URL/api/admin/logs?limit=200" 2>/dev/null \
    | grep -o '"text":"[^"]*composite saved[^"]*"' \
    | tail -1 | sed 's/"text":"//;s/"//'
}

# DEPLOY-MARKER を Node ログに投稿
post_deploy_marker() {
  local msg="$1"
  curl -sf -X POST "$NODE_URL/api/admin/notify" "${ADMIN_HDR[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"[DEPLOY-MARKER] $msg\"}" \
    -o /dev/null --max-time 10 || true
}

# ═══════════════════════════════════════════════════════════════════════════════
# ステータス表示
# ═══════════════════════════════════════════════════════════════════════════════
print_status() {
  step "システム状態確認 ($(date '+%Y-%m-%d %H:%M:%S'))"

  # ── Node ──
  if node_alive; then
    local comp
    comp=$(node_last_composite)
    ok "Node server :3000"
    [[ -n "$comp" ]] && info "最後の合成: $comp" || info "合成ログ未取得"
  else
    fail "Node server :3000 — 応答なし"
  fi

  # ── Mac Swift app ──
  if mac_alive; then
    if mac_is_stuck; then
      warn "Mac Swift app :$MAC_PORT — 起動中だが isSending スタック"
      info "  ▶ 根本原因: iPhone バックグラウンド化 → TCP 接続がハング"
      info "  ▶ 対処: iPhone を前面に出してから Mac app を再起動"
    else
      ok "Mac Swift app :$MAC_PORT"
    fi
  else
    fail "Mac Swift app :$MAC_PORT — 応答なし (launchd が落ちているか未起動)"
  fi

  # ── Swift ログ末尾 ──
  if [[ -f "$SWIFT_LOG" ]]; then
    info "Swift ログ末尾 (最新5行):"
    tail -5 "$SWIFT_LOG" | sed 's/^/    /'
  fi

  # ── iPhone / HEIC ──
  local age
  age=$(latest_heic_age_min)
  local f
  f=$(ls -t "$RAW_DIR"/*.heic 2>/dev/null | head -1)
  if [[ $age -le 5 ]]; then
    ok "iPhone 撮影 — ${age}分以内に HEIC 到着"
  elif [[ $age -le 15 ]]; then
    warn "iPhone 撮影 — 最新 HEIC は ${age}分前 (やや古い)"
  elif [[ $age -lt 9999 ]]; then
    fail "iPhone 撮影 — 最新 HEIC は ${age}分前 (撮影停止の疑い)"
  else
    fail "iPhone 撮影 — HEIC ファイルなし"
  fi
  if [[ -n "$f" ]]; then
    local kb=$(( $(stat -f %z "$f") / 1024 ))
    info "最新: $(basename "$f") (${kb}KB)"
    [[ $kb -lt 100 ]] && warn "  ▶ サイズが小さい (初期化/黒フレームの可能性)"
  fi

  # ── launchd ジョブ一覧 ──
  echo ""
  info "launchd ジョブ:"
  launchctl list 2>/dev/null | grep eggcamera | while read -r pid exit_code label; do
    if [[ "$pid" == "-" ]]; then
      printf "    ${YLW}%-42s${RST} PID=なし  最終終了=%s\n" "$label" "$exit_code"
    else
      printf "    ${GRN}%-42s${RST} PID=%s\n" "$label" "$pid"
    fi
  done
}

# ═══════════════════════════════════════════════════════════════════════════════
# 再起動ヘルパー
# ═══════════════════════════════════════════════════════════════════════════════
restart_node() {
  warn "Node server 再起動..."
  run "launchctl kickstart -k gui/$(id -u)/com.eggcamera.node"
  sleep 8
  if [[ $DRY_RUN -eq 1 ]] || node_alive; then
    ok "Node server 再起動 OK"
    return 0
  else
    fail "Node server が応答しない — /Users/eggcamera/Library/Logs/eggcamera-node.err を確認してください"
    return 1
  fi
}

restart_mac() {
  warn "Mac Swift app 再起動..."
  run "launchctl kickstart -k gui/$(id -u)/com.eggcamera.mac"
  sleep 8
  if [[ $DRY_RUN -eq 1 ]] || mac_alive; then
    ok "Mac Swift app 再起動 OK"
    return 0
  else
    fail "Mac Swift app が応答しない — /Users/eggcamera/Library/Logs/eggcamera-mac.err を確認してください"
    return 1
  fi
}

restart_iphone() {
  warn "iPhone アプリ再起動..."
  if ! xcrun devicectl list devices 2>/dev/null | grep -q connected; then
    warn "iPhone が USB 接続されていないため、iPhone 再起動をスキップ"
    info "  ▶ iPhone を USB 接続してロックを解除してから ./recover.sh を再実行してください"
    return 1
  fi
  if run "\"$IPHONE_SH\" restart 2>&1"; then
    ok "iPhone アプリ起動コマンド送信"
    return 0
  else
    fail "iphone.sh restart 失敗 — USB接続とロック解除を確認してください"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# エンドツーエンド確認（テストキャプチャ → HEIC 到着を確認）
# ═══════════════════════════════════════════════════════════════════════════════
verify_capture() {
  info "テストキャプチャ送信 → HEIC 到着を最大 ${VERIFY_TIMEOUT_SEC}s 待機..."

  # wall-clock で「送信した瞬間」を記録し、それ以降の HEIC を新着とみなす
  # （リカバリ中に別のフローで HEIC が作られても誤検知しないように mtime ではなく時刻で比較）
  local send_ts
  send_ts=$(date +%s)

  run "curl -sf -X POST localhost:$MAC_PORT/capture -o /dev/null"
  [[ $DRY_RUN -eq 1 ]] && { info "(dry-run: 確認スキップ)"; return 0; }

  local waited=0
  while [[ $waited -lt $VERIFY_TIMEOUT_SEC ]]; do
    sleep 5; waited=$((waited + 5))
    # send_ts 以降に更新された HEIC を探す
    local new_heic
    new_heic=$(find "$RAW_DIR" -name "*.heic" -newer <(touch -t "$(date -r $send_ts +%Y%m%d%H%M.%S)" /tmp/eggcam_ref 2>/dev/null; echo /tmp/eggcam_ref) 2>/dev/null | head -1)
    # macOS 互換の -newer 代替: mtime > send_ts のファイルを手動フィルタ
    if [[ -z "$new_heic" ]]; then
      for f in "$RAW_DIR"/*.heic; do
        [[ -f "$f" ]] || continue
        [[ $(stat -f %m "$f") -gt $send_ts ]] && { new_heic="$f"; break; }
      done
    fi
    if [[ -n "$new_heic" ]]; then
      local kb=$(( $(stat -f %z "$new_heic") / 1024 ))
      if [[ $kb -lt 100 ]]; then
        warn "HEIC 到着 (${kb}KB) — サイズ小 (初期化フレーム?)"
        info "  ▶ 次の正常なサイクルで 1MB+ の写真が来るか様子を見てください"
      else
        ok "HEIC 到着 (${kb}KB) — キャプチャ正常確認"
      fi
      return 0
    fi
    printf "    待機中 %ds / %ds...\n" $waited $VERIFY_TIMEOUT_SEC
  done

  fail "${VERIFY_TIMEOUT_SEC}s 待機したが HEIC 届かず"
  return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# メイン: 診断 → 優先順位で修復
# ═══════════════════════════════════════════════════════════════════════════════
main() {
  printf "\n╔══════════════════════════════════════════════════╗\n"
  printf   "║  EggCamera リカバリスクリプト                    ║\n"
  printf   "║  %s JST ║\n" "$(date '+%Y-%m-%d %H:%M:%S')"
  printf   "╚══════════════════════════════════════════════════╝\n"
  [[ $DRY_RUN -eq 1 ]] && printf "(--dry-run モード: 実際には何も変更しません)\n"

  print_status

  [[ $STATUS_ONLY -eq 1 ]] && exit 0

  step "修復判定"

  local need_verify=0

  # ──────────────────────────────────────────────────────────
  # 優先度 1: Node server が死んでいる
  #   → 他の全機能が使えないため最優先で復旧
  # ──────────────────────────────────────────────────────────
  if ! node_alive; then
    info "▶ Node server が停止 → 再起動"
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: Node 再起動開始"
    restart_node || exit 1
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: Node 再起動完了"
    need_verify=1
  fi

  # ──────────────────────────────────────────────────────────
  # 優先度 2: Mac Swift app が応答しない
  #   → iPhone を先に前面化してから Mac を再起動
  #     （Mac 起動直後の最初のトリガーを iPhone が受けられるようにする）
  # ──────────────────────────────────────────────────────────
  if ! mac_alive; then
    info "▶ Mac Swift app 停止 → iPhone 前面化 → Mac 再起動"
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: Mac/iPhone 再起動開始"
    restart_iphone || true   # iPhone なくても継続
    sleep 10
    restart_mac || exit 1
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: Mac/iPhone 再起動完了"
    need_verify=1

  # ──────────────────────────────────────────────────────────
  # 優先度 3: Mac は生きているが isSending でスタック
  #   原因: iPhone がバックグラウンド → TCP ハング → isSending=true のまま
  #   対処: iPhone を前面に出してから Mac を再起動して isSending をリセット
  # ──────────────────────────────────────────────────────────
  elif mac_is_stuck; then
    info "▶ isSending スタック → iPhone 前面化 → Mac 再起動"
    info "  (iPhone がバックグラウンドで iOS にサスペンドされたことが原因)"
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: isSending スタック解除開始"
    restart_iphone || true
    sleep 10
    restart_mac || exit 1
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: isSending スタック解除完了"
    need_verify=1

  # ──────────────────────────────────────────────────────────
  # 優先度 4: Mac は正常だが撮影が止まっている
  #   原因: iPhone がバックグラウンド化して Bonjour タイムアウトを繰り返している
  #   対処: iPhone アプリを再起動して前面に出す
  # ──────────────────────────────────────────────────────────
  elif [[ -z "$(recent_heic_within $STALE_HEIC_MINUTES)" ]]; then
    local age
    age=$(latest_heic_age_min)
    info "▶ 直近 HEIC が ${age}分前 → iPhone アプリを再起動"
    [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: iPhone 再起動開始 (撮影停止 ${age}分)"
    if restart_iphone; then
      sleep 15
      # iPhone 再起動後に isSending がスタックしていれば Mac も再起動
      if mac_is_stuck; then
        warn "iPhone 再起動後に isSending スタック → Mac も再起動"
        restart_mac || exit 1
      fi
      [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: iPhone 再起動完了"
      need_verify=1
    else
      fail "iPhone 再起動不可 — 手動で iPhone を確認してください"
      exit 1
    fi

  # ──────────────────────────────────────────────────────────
  # 全て正常
  # ──────────────────────────────────────────────────────────
  else
    ok "全コンポーネント正常 — 修復不要"
    info "  もし撮影に問題がある場合は --status で詳細を確認してください"
    exit 0
  fi

  # ── エンドツーエンド確認 ──────────────────────────────────
  if [[ $need_verify -eq 1 ]]; then
    step "動作確認"
    if verify_capture; then
      step "リカバリ完了"
      ok "システム正常稼働を確認"
      [[ $DRY_RUN -eq 0 ]] && post_deploy_marker "recover.sh: リカバリ完了・撮影正常確認"
    else
      step "リカバリ部分的"
      warn "キャプチャ未確認 — 以下を手動確認してください:"
      info "  1. iPhone の画面が表示されているか（バックグラウンドでないか）"
      info "  2. iPhone がロック解除されているか"
      info "  3. iPhone と Mac が同じ Wi-Fi か USB で繋がっているか"
      info "  4. data/logs/swift/app.log の末尾に 'bonjourTimeout' が出ていないか"
      info "  5. 上記を確認して問題なければ: ./recover.sh を再実行"
      exit 1
    fi
  fi
}

main
