#!/bin/zsh
# iPad（フォトブース表示機）を再起動する。
# Apple 純正 CoreDevice CLI（xcrun devicectl）を使う＝sudo不要・WiFi/ネットワーク対応。
# （iphone.sh が iPhone に使うのと同じ仕組み。pymobiledevice3+tunnel は sudo 必須で遠回りだった）
# 本番は iPad が WiFi のみでも devicectl は .coredevice.local 経由で到達できる。
#
# 注意: 再起動後 iPad の Safari/EggCamera は自動起動しない。本番はキオスク自動起動
#       (Apple Configurator の自律型シングルAppモード等) が別途必要。
#       テストは harness の Safari 復旧フォールバックで次セッションに再起動する。
set -u

IPAD_UDID="00008132-001E2934019A401C"   # EggCameraのiPad (iPad16,10)

echo "iPad ($IPAD_UDID) を再起動します（devicectl・sudo不要）…"
xcrun devicectl device reboot --device "$IPAD_UDID"
RC=$?
echo "iPad 再起動コマンド送信完了 (rc=$RC)"
exit $RC
