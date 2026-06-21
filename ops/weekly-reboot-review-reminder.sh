#!/bin/zsh
# 「weekly-reboot を週次に戻すか」判断リマインダー（2026-06-24 16:30 に1回だけ発火）。
# 新スケジュール(日次reboot-test 3:00/15:00 ＋ 毎時テスト)の試用期間(06-21〜06-24)の
# 健全性を要約し、Slack ＋ /api/test-report に通知する。
# 発火後は自分の plist を .fired にリネームして一回限りにする(bootoutは自己kill回避で行わない。
# 次の日次再起動で launchd から外れる)。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

SELF_PLIST="$HOME/Library/LaunchAgents/com.eggcamera.weekly-reboot-review.plist"
RBLOG="$HOME/Library/Logs/eggcamera-weekly-reboot.log"
HRLOG="$HOME/Library/Logs/eggcamera-hourly-test.log"
SLACK_ENV="$HOME/EggCamera/.env.slack"
MARK="http://127.0.0.1:3000/api/test-report"
RANGE='2026-06-2[1-4]'   # 試用期間の日付

# ── 試用期間の健全性サマリ（best-effort。ログ形式が違っても0で安全に続行）──
# grep -c は0件でも「0」を出力し終了コード1を返す → `|| echo 0` は余分な0を足すので使わない。
# 値が空(ファイル無し等)のときだけ ${x:-0} で0にする。
reboots=$(grep -cE "${RANGE}.*週次3台再起動 開始" "$RBLOG" 2>/dev/null); reboots=${reboots:-0}
aborts=$(grep -E "$RANGE" "$RBLOG" 2>/dev/null | grep -cE "中止|未復帰"); aborts=${aborts:-0}
hruns=$(grep -cE "${RANGE}.*完了:" "$HRLOG" 2>/dev/null); hruns=${hruns:-0}
hfails=$(grep -E "${RANGE}.*完了:" "$HRLOG" 2>/dev/null | grep -oE "失敗[0-9]+" | grep -oE "[0-9]+" | awk '{s+=$1} END{print s+0}')

SUM="試用(06-21〜24): 日次再起動テスト=${reboots}回(中止/未復帰=${aborts}) / 毎時テスト完走=${hruns}回(累計失敗サイクル=${hfails})"
TEXT="weekly-reboot 戻し判断の時期です(2026-06-24)。${SUM}。問題なければ weekly-reboot を週次(木21:50)へ戻す(復元: ~/Library/LaunchAgents/ の .plist.disabled を .plist に戻して launchctl bootstrap)。戻す際は reboot-test と二重再起動にならないよう一方へ集約。詳細はメモリ hourly-ipad-test-schedule / worklog 2026-06-20。"

# ── test-report マーカー ──
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data "$(printf '{"level":"info","text":"DEPLOY-MARKER(reboot-review): %s"}' "$TEXT")" >/dev/null 2>&1

# ── Slack 通知 ──
if [ -f "$SLACK_ENV" ]; then
  url=$(grep -E '^SLACK_WEBHOOK_URL=' "$SLACK_ENV" | head -1 | cut -d= -f2- | tr -d '"'\'' ')
  [ -n "$url" ] && curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":":white_check_mark: *通知：対処不要*\n:calendar: *weekly-reboot 戻し判断リマインダー*\n%s"}' "$TEXT")" "$url" >/dev/null 2>&1
fi

# ── 一回限り化: plist を .fired にして次回ブートで読み込ませない ──
[ -f "$SELF_PLIST" ] && mv "$SELF_PLIST" "${SELF_PLIST}.fired" 2>/dev/null

echo "[$(date '+%F %T')] reboot-review reminder fired: $SUM" >> "$HOME/Library/Logs/eggcamera-reboot-review.log"
