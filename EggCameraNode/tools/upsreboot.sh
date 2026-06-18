#!/bin/zsh
# UPS がバッテリー給電に切り替わったら安全にリブートする。
# スマートプラグを切ることで Mac mini を遠隔リブートする用途に使う。
#
# 前提:
#   - UPS が USB で Mac mini に接続されている
#   - システム設定 > バッテリー > 「停電後に自動的に起動」が ON
#   - /Library/LaunchDaemons/com.eggcamera.upsreboot.plist で root として常駐

LOG_TAG="eggcamera-upsreboot"
# 瞬断と意図的なスマートプラグ操作を区別するための確認待ち秒数
CONFIRM_SECS=8
POLL_SECS=5

logger -t "$LOG_TAG" "daemon started"

while true; do
    if pmset -g batt 2>/dev/null | grep -q "Battery Power"; then
        logger -t "$LOG_TAG" "UPS on battery detected — confirming in ${CONFIRM_SECS}s"
        sleep "$CONFIRM_SECS"
        if pmset -g batt 2>/dev/null | grep -q "Battery Power"; then
            logger -t "$LOG_TAG" "confirmed — initiating safe reboot"
            # 監査統一のためガードレール経由（root常駐＝launchd配下なので許可される）。未設置時は直接。
            if [ -x /Library/EggCamera/bin/eggcamera-safe-reboot ]; then
                /Library/EggCamera/bin/eggcamera-safe-reboot
            else
                /sbin/shutdown -r now
            fi
        else
            logger -t "$LOG_TAG" "AC restored within confirm window — abort reboot"
        fi
    fi
    sleep "$POLL_SECS"
done
