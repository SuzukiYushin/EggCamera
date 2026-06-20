#!/bin/zsh
# appium-tunnel kickstart の NOPASSWD 許可を導入する（最小権限・visudo検証付き）。
#   実行: sudo /Users/eggcamera/EggCamera/ops/install-appium-kickstart-nopasswd.sh
#
# これにより Mac再起動後のiPad自動復旧（WiFi再起動→usbmux復帰→daemon kickstart）が
# 無人で完了できるようになる（kickstartのパスワード要求＝現行の最大ブロッカーを解消）。
set -eu
if [ "$(id -u)" -ne 0 ]; then echo "❌ sudo で実行してください: sudo $0" >&2; exit 1; fi

SRC=/Users/eggcamera/EggCamera/ops
WRAP_SRC="$SRC/bin/eggcamera-appium-kickstart"
WRAP_DST=/Library/EggCamera/bin/eggcamera-appium-kickstart
SUDO_SRC="$SRC/sudoers.d/eggcamera-appium-kickstart"
SUDO_DST=/etc/sudoers.d/eggcamera-appium-kickstart

echo "== 1) kickstart 専用ラッパー設置 =="
mkdir -p /Library/EggCamera/bin
install -o root -g wheel -m 0755 "$WRAP_SRC" "$WRAP_DST"
echo "   $WRAP_DST"

echo "== 2) sudoers 設置（visudo 検証）=="
# まず一時ファイルで検証してから本設置（壊れたsudoersでロックしないため）
TMP="$(mktemp)"; install -m 0440 "$SUDO_SRC" "$TMP"
if ! visudo -cf "$TMP" >/dev/null 2>&1; then echo "   ❌ visudo 検証失敗→中止"; rm -f "$TMP"; exit 1; fi
install -o root -g wheel -m 0440 "$SUDO_SRC" "$SUDO_DST"; rm -f "$TMP"
visudo -cf "$SUDO_DST" >/dev/null 2>&1 && echo "   ✅ $SUDO_DST 設置・検証OK" || { echo "   ❌ 検証失敗→撤去"; rm -f "$SUDO_DST"; exit 1; }

echo "== 3) NOPASSWD 動作確認（eggcameraユーザで実行）=="
if sudo -u eggcamera sudo -n "$WRAP_DST" >/dev/null 2>&1; then
  echo "   ✅ 'sudo -n $WRAP_DST' がパスワード不要で実行できた（daemon kickstart済）"
else
  echo "   ⚠ まだNOPASSWDで実行できない（要確認）"
fi
echo "完了。以後、自動復旧スクリプトが無人で kickstart できます。"
