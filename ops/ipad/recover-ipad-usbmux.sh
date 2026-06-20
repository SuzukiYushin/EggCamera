#!/bin/zsh
# Mac再起動後にiPadがusbmuxから脱落した時の自動復旧（物理抜き差し不要）。
#   WiFi(devicectl)でiPadを再起動 → 起動時にUSBが再列挙されusbmuxへ復帰
#   → appium-tunnel daemon に kickstart(NOPASSWDラッパー)で取り込ませる → registry:42314へ。
# 前提: iPadのUSBが物理接続されていること（WiFi再起動でのusbmux再列挙はUSB接続が要る）。
#       NOPASSWDラッパー(ops/install-appium-kickstart-nopasswd.sh)導入済みなら無人で完了。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u
IPAD="00008132-001E2934019A401C"
KICK="/Library/EggCamera/bin/eggcamera-appium-kickstart"

on_usbmux(){ idevice_id -l 2>/dev/null | grep -q "$IPAD"; }
in_registry(){ curl -s -m3 http://localhost:42314/remotexpc/tunnels 2>/dev/null | grep -q "$IPAD"; }

echo "==== $(date '+%F %T') iPad usbmux 自動復旧 開始 ===="
if in_registry; then echo "  ✅ 既にregistry在席。何もしない。"; exit 0; fi

if ! on_usbmux; then
  echo "  iPad usbmux脱落 → WiFi再起動(devicectl)で再列挙を試行"
  xcrun devicectl device reboot --device "$IPAD" --timeout 30 2>&1 | grep -iE 'requested|error' | head -1
  echo "  usbmux復帰を待機(最大4分)…"
  for i in $(seq 1 48); do sleep 5; on_usbmux && { echo "  ✅ usbmux復帰 ($((i*5))s)"; break; }; done
fi
if ! on_usbmux; then echo "  ❌ usbmuxに戻らず（iPadのUSB物理接続を確認）"; exit 1; fi

echo "  daemonへ取り込み(kickstart)"
if [ -x "$KICK" ]; then
  sudo -n "$KICK" >/dev/null 2>&1 && echo "  ✅ NOPASSWD kickstart 実行" \
    || echo "  ⚠ kickstart失敗（NOPASSWDルール未導入? → ops/install-appium-kickstart-nopasswd.sh）"
else
  echo "  ⚠ ラッパー未導入。手動: sudo launchctl kickstart -k system/com.eggcamera.appium-tunnel"
fi

echo "  registry反映を待機(最大40s)…"
for i in $(seq 1 40); do sleep 1; in_registry && { echo "  ✅ iPad registry在席＝復旧完了"; exit 0; }; done
echo "  ❌ registry未反映"; exit 1
