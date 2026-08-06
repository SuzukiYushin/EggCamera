#!/bin/zsh
# USB切断期間中(2026-07-11〜)のWi-Fi経由WDA構成の復旧スクリプト。
# 前提: iPad EnableWifiConnections=true 設定済み(usbmuxdにNetwork登録される)。
# 構成: xcodebuild(WDA起動/Wi-Fi CoreDevice) + フォワーダ(127.0.0.1:18100→iPad:8100)
# 使い方: ./wda-wifi-recovery.sh   (冪等・稼働中なら何もしない)
set -u
IPAD_UDID="00008132-001E2934019A401C"
IPAD_IP="${IPAD_IP:-192.168.11.104}"   # remote-control.sh が mDNS で解決した実IPを渡してくる
FWD_PORT=18100
LOG_DIR="$HOME/Library/Logs"

# 1. WDA 応答確認 → 死んでいれば xcodebuild 再起動
if ! curl -s -m 5 -o /dev/null "http://${IPAD_IP}:8100/status"; then
  echo "$(date '+%F %T') WDA無応答 → xcodebuild再起動"
  pkill -f "xcodebuild test-without-building.*${IPAD_UDID}" 2>/dev/null
  sleep 2
  nohup /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building \
    -project /Users/eggcamera/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj \
    -scheme WebDriverAgentRunner \
    -derivedDataPath /Users/eggcamera/Library/Developer/Xcode/DerivedData/WebDriverAgent-dopylywrbtefnbfmomfcvcirfvqt \
    -destination "id=${IPAD_UDID}" \
    IPHONEOS_DEPLOYMENT_TARGET=26.5 GCC_TREAT_WARNINGS_AS_ERRORS=0 COMPILER_INDEX_STORE_ENABLE=NO \
    > "${LOG_DIR}/eggcamera-wda-wifi.log" 2>&1 &
  # 起動待ち(最大3分)
  for i in {1..18}; do
    sleep 10
    curl -s -m 5 -o /dev/null "http://${IPAD_IP}:8100/status" && { echo "$(date '+%F %T') WDA復帰"; break; }
  done
fi

# 2. フォワーダ確認 → 死んでいれば再起動
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:${FWD_PORT}/status"; then
  echo "$(date '+%F %T') フォワーダ無応答 → 再起動"
  pkill -f "wda-forwarder\\.js" 2>/dev/null   # keepalive を巻き込まないよう .js まで指定
  sleep 1
  nohup node /Users/eggcamera/EggCamera/ops/ipad/wda-forwarder.js \
    > "${LOG_DIR}/eggcamera-wda-forwarder.log" 2>&1 &
  sleep 2
fi

# 3. 最終確認
if curl -s -m 5 -o /dev/null "http://127.0.0.1:${FWD_PORT}/status"; then
  echo "$(date '+%F %T') ✅ Wi-Fi WDA構成 正常 (127.0.0.1:${FWD_PORT} → ${IPAD_IP}:8100)"
  exit 0
else
  # 失敗の内訳を必ず出す。フォワーダはローカルネットワーク権限(TCC)が要るため、
  # launchd から起動すると iPad へ繋げず必ず失敗する（Mac再起動で権限がリセットされる
  # のと同じ既知の制約）。iPadへ直接届くかで原因を確定させる。
  if curl -s -m 5 -o /dev/null "http://${IPAD_IP}:8100/status"; then
    echo "$(date '+%F %T') ❌ フォワーダのみ起動不可 (iPadは直接応答OK)"
    echo "     → 対話シェル(ターミナル/tmux)で $0 を実行すれば復旧する。"
    echo "        launchd 実行だとローカルネットワーク権限が無いため復旧できない。"
  else
    echo "$(date '+%F %T') ❌ iPad本体が不通 (直接 ${IPAD_IP}:8100 も無応答)"
    echo "     → iPadの電源/Wi-Fi接続/WDA常駐を確認する。"
  fi
  exit 1
fi
