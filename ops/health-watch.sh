#!/bin/zsh
# 機械化ヘルスチェック（Claude非依存・2026-07-04新設）。
# 毎時:40 に launchd(com.eggcamera.health-watch) から実行される。
# hourly-claude-watch(:50, claude -p) の点検項目のうち機械化できるものを shell で常時代替し、
# Claude Code が使えない本番運用でも生きる監視レイヤにする（claude-watch との併走は無害）。
#
# チェック項目:
#   1. node(:3000) 死活          → 落ちていれば alert（キオスク停止相当）
#   2. node RSS                  → NODE_RSS_ALERT_MB 超で alert（プレビュー/合成の肥大再燃検知）
#   3. disk 空き                 → DISK_MIN_GB 未満で alert
#   4. 肥大ログ                  → LOG_MAX_MB 超で alert（truncateは再起動テスト/週次メンテに任せ検知のみ）
#   5. 毎時テスト連続失敗        → 直近2回の結果が連続失敗(失敗>0/異常終了)なら alert
#
# 通知: 異常時のみ Slack + /api/test-report(alert)。正常時は無通知。
# 連投防止: 状態ファイルに発報済みキーを記録し、その異常が解消するまで再通知しない。
# 再起動直後(uptime<15分)は復旧途中の偽alertを避けるため全チェックをスキップする。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

LOG="$HOME/Library/Logs/eggcamera-health-watch.log"
STATE="$HOME/Library/Logs/eggcamera-health-watch.state"
SLACK_ENV="/Users/eggcamera/EggCamera/.env.slack"
NODE_ENV_FILE="/Users/eggcamera/EggCamera/EggCameraNode/.env"
HOURLY_LOG="$HOME/Library/Logs/eggcamera-hourly-test.log"

NODE_RSS_ALERT_MB=${NODE_RSS_ALERT_MB:-700}
DISK_MIN_GB=${DISK_MIN_GB:-50}
LOG_MAX_MB=${LOG_MAX_MB:-500}

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
touch "$STATE"

# ── 通知（Slack + test-report）。key で連投防止 ──────────────────────────
notify() { # key text
  local key="$1" text="$2"
  if grep -q "^$key$" "$STATE" 2>/dev/null; then
    log "既発報のためスキップ: $key"
    return 0
  fi
  echo "$key" >> "$STATE"
  log "ALERT: $key — $text"
  curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
    --data "$(printf '{"level":"alert","text":"health-watch: %s"}' "$text")" >/dev/null 2>&1
  if [ -f "$SLACK_ENV" ]; then
    local url; url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
    [ -n "$url" ] && curl -s -m 10 -X POST "$url" -H 'Content-Type: application/json' \
      --data "$(printf '{"text":":rotating_light: *EggCamera health-watch*\\n%s"}' "$text")" >/dev/null 2>&1
  fi
}

# 異常が解消していたら発報済みキーを外す（次の発生で再度通知できるように）
clear_key() { # key
  grep -q "^$1$" "$STATE" 2>/dev/null || return 0
  grep -v "^$1$" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  log "解消: $1"
}

# ── 再起動直後は復旧途中の偽alertを避けるためスキップ ─────────────────────
boot_epoch=$(sysctl -n kern.boottime | sed -n 's/.*sec = \([0-9]*\).*/\1/p')
if [ -n "$boot_epoch" ] && [ $(( $(date +%s) - boot_epoch )) -lt 900 ]; then
  log "uptime<15分(再起動直後) → 全チェックスキップ"
  exit 0
fi

# ── 1. node 死活 ──────────────────────────────────────────────────────────
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || echo 000)
if [ "$code" != 200 ]; then
  notify "node-down" "node(:3000)が応答しません(HTTP $code)。キオスク停止の可能性。launchctl kickstart -k gui/501/com.eggcamera.node で再起動を。"
else
  clear_key "node-down"

  # ── 2. node RSS（node生存時のみ）────────────────────────────────────────
  token=$(grep -E '^ADMIN_TOKEN=' "$NODE_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"')
  rss=$(curl -s -m 5 -H "X-Admin-Token: $token" http://127.0.0.1:3000/api/admin/metrics 2>/dev/null \
        | sed -n 's/.*"rssMB":\([0-9.]*\).*/\1/p')
  if [ -n "$rss" ] && [ "${rss%.*}" -ge "$NODE_RSS_ALERT_MB" ]; then
    notify "node-rss" "node RSSが${rss}MB(閾値${NODE_RSS_ALERT_MB}MB)。プレビュー/合成の肥大再燃の疑い。継続なら kickstart -k gui/501/com.eggcamera.node。"
  else
    [ -n "$rss" ] && clear_key "node-rss"
  fi
fi

# ── 3. disk 空き ──────────────────────────────────────────────────────────
free_gb=$(df -g / | awk 'NR==2 {print $4}')
if [ -n "$free_gb" ] && [ "$free_gb" -lt "$DISK_MIN_GB" ]; then
  notify "disk-low" "disk空きが${free_gb}GB(閾値${DISK_MIN_GB}GB)。データ整理が必要です。"
else
  clear_key "disk-low"
fi

# ── 4. 肥大ログ ───────────────────────────────────────────────────────────
for f in "$HOME/Library/Logs/eggcamera-iproxy.out" "$HOME/Library/Logs/eggcamera-appium.out" "/tmp/appium.log"; do
  key="log-bloat-$(basename "$f")"
  sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
  if [ $(( sz / 1048576 )) -ge "$LOG_MAX_MB" ]; then
    notify "$key" "肥大ログ: $f が$(( sz / 1048576 ))MB(閾値${LOG_MAX_MB}MB)。次回再起動テストのtruncateで解消予定・急ぐ場合は「: > $f」。"
  else
    clear_key "$key"
  fi
done

# ── 5. 毎時テスト連続失敗 ────────────────────────────────────────────────
# 直近2回の結果行(完了: or 異常終了)を見る。両方失敗なら発報。
if [ -f "$HOURLY_LOG" ]; then
  results=$(grep -E "完了: |異常終了" "$HOURLY_LOG" | tail -2)
  n=0; fails=0
  if [ -n "$results" ]; then
    n=$(echo "$results" | grep -c "")
    fails=$(echo "$results" | grep -cE "失敗[1-9]|異常終了")
  fi
  if [ "$n" -ge 2 ] && [ "$fails" -ge 2 ]; then
    last=$(echo "$results" | tail -1 | tr -d '"')
    notify "hourly-fail" "毎時テストが2回連続失敗。直近: ${last}。iPhone/iPad/署名の確認を。"
  else
    clear_key "hourly-fail"
  fi
fi

log "チェック完了 (node=$code rss=${rss:-?}MB disk=${free_gb:-?}GB)"
