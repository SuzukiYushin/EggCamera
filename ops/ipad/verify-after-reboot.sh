#!/bin/zsh
# Mac再起動後に、iPad Appiumトンネルの恒久setupが自動復帰したかを一発判定する。
# sudo不要。再起動後にそのまま実行: ~/EggCamera/ops/ipad/verify-after-reboot.sh
#
# 判定項目:
#   1) com.eggcamera.appium-tunnel daemon が自動起動しているか
#   2) tunnelレジストリ :42314 が応答し iPad が登録されているか
#   3) iPad が usbmux に残っているか（落ちていれば USB-C 抜き差しが必要）
#   4) (任意) Appium がセッション作成できるか（--smoke 指定時のみ・約30秒）
# 結果は DEPLOY-MARKER として /api/test-report にも投稿する。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u
IPAD="00008132-001E2934019A401C"
PMD="/Users/eggcamera/.local/bin/pymobiledevice3"
fails=0
note=""

echo "==== $(date '+%F %T') iPad恒久setup 再起動後検証 ===="

# 0) Wi-Fiモード(USB切断期間・2026-07-12〜): USBトンネル系の検証は無意味なので、
#    代わりにWi-Fi WDA構成(xcodebuild+フォワーダ)を再建して判定する。
#    Mac再起動でシェル起動のWDA/フォワーダは必ず消えているため、ここでの再建が
#    直後のpost-boot検証テスト(ipad-test.js直接実行)の成立条件になる。
if [ -f "/Users/eggcamera/EggCamera/ops/ipad/.wda-wifi-mode" ]; then
  echo "— Wi-Fiモード検出: USBトンネル検証をスキップしWi-Fi WDA構成を再建 —"
  if /Users/eggcamera/EggCamera/ops/ipad/wda-wifi-recovery.sh; then
    echo "==== ✅ 合格(Wi-Fiモード): WDA構成 再建OK ===="
    curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
      --data '{"level":"info","text":"DEPLOY-MARKER(verify-after-reboot): Wi-FiモードWDA構成の再建OK(USB切断期間)"}' >/dev/null 2>&1
    exit 0
  else
    echo "==== ⚠ 不合格(Wi-Fiモード): WDA構成 再建失敗 ===="
    curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
      --data '{"level":"alert","text":"DEPLOY-MARKER(verify-after-reboot): Wi-FiモードWDA構成の再建失敗(iPad電源/Wi-Fi要確認)"}' >/dev/null 2>&1
    exit 1
  fi
fi

# 1) daemon 自動起動
if launchctl print system/com.eggcamera.appium-tunnel 2>/dev/null | grep -q 'state = running'; then
  echo "✅ 1) daemon(com.eggcamera.appium-tunnel) 稼働中"
else
  echo "❌ 1) daemon が動いていない"; fails=$((fails+1)); note="$note daemon停止;"
fi

# ★iPadがusbmuxから脱落していたら、レジストリ/usbmux判定の前に自動復旧を試みる。
#   WiFi再起動→usbmux再列挙→NOPASSWD kickstart→daemon取込（物理抜き差し不要）。
#   NOPASSWDラッパー(ops/install-appium-kickstart-nopasswd.sh)導入済みなら無人で完了する。
if ! idevice_id -l 2>/dev/null | grep -q "$IPAD"; then
  echo "⚠ iPad usbmux脱落を検知 → 自動復旧を試行（WiFi再起動→kickstart, 最大~5分）"
  /Users/eggcamera/EggCamera/ops/ipad/recover-ipad-usbmux.sh 2>&1 | sed 's/^/   /'
fi

# レジストリは起動直後だと遅れることがあるので最大40秒待つ
echo "   レジストリ:42314 を待機(最大40s)…"
reg=""
for i in $(seq 1 40); do
  reg="$(curl -s -m 2 http://localhost:42314/remotexpc/tunnels 2>/dev/null)"
  [ -n "$reg" ] && echo "$reg" | grep -q "$IPAD" && break
  sleep 1
done

# 2) レジストリ + iPad
if echo "$reg" | grep -q "$IPAD"; then
  echo "✅ 2) レジストリ:42314 に iPad 登録あり"
else
  echo "❌ 2) レジストリに iPad 無し（応答: ${reg:0:80}）"; fails=$((fails+1)); note="$note registry無iPad;"
fi

# 3) usbmux 生存（落ちていたら抜き差し必要）
if "$PMD" usbmux list 2>/dev/null | grep -q "$IPAD"; then
  echo "✅ 3) iPad は usbmux に在席（抜き差し不要）"
else
  echo "❌ 3) iPad が usbmux から脱落 → USB-C 抜き差し後に: sudo launchctl kickstart -k system/com.eggcamera.appium-tunnel"
  fails=$((fails+1)); note="$note usbmux脱落(要抜き差し);"
fi

# 4) 任意スモーク
if [ "${1:-}" = "--smoke" ] && [ "$fails" -eq 0 ]; then
  echo "   Appiumセッション スモーク(約30秒)…"
  : > /tmp/verify-smoke.log
  ( node /Users/eggcamera/EggCamera/EggCameraNode/tools/ipad-test.js > /tmp/verify-smoke.log 2>&1 & echo $! > /tmp/verify-smoke.pid )
  for i in $(seq 1 20); do
    sleep 2
    grep -q 'セッション:' /tmp/verify-smoke.log 2>/dev/null && { echo "✅ 4) Appiumセッション作成OK"; break; }
    grep -qi 'Unknown device' /tmp/verify-smoke.log 2>/dev/null && { echo "❌ 4) Unknown device（トンネル未登録）"; fails=$((fails+1)); note="$note session作成失敗;"; break; }
  done
  kill "$(cat /tmp/verify-smoke.pid 2>/dev/null)" 2>/dev/null || true
fi

# 結果サマリ＋マーカー
if [ "$fails" -eq 0 ]; then
  level=info; summary="再起動後OK: daemon自動起動・registry・iPad usbmux生存すべて正常"
  echo "==== ✅ 合格: $summary ===="
else
  level=alert; summary="再起動後 要対応(${fails}件): ${note}"
  echo "==== ⚠ 不合格: $summary ===="
fi
curl -s -m 8 -X POST http://127.0.0.1:3000/api/test-report -H 'Content-Type: application/json' \
  --data "$(printf '{"level":"%s","text":"DEPLOY-MARKER(verify-after-reboot): %s"}' "$level" "$summary")" >/dev/null 2>&1 && echo "(マーカー投稿済)"
exit "$fails"
