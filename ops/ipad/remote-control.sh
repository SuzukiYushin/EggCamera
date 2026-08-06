#!/bin/zsh
#
# remote-control.sh — Mac から iPad を遠隔操作する手段を「使う時だけ」立ち上げる。
#
# なぜ普段は止めるのか:
#   遠隔で画面を見る／タップするには WDA(WebDriverAgent = XCUITest) が要るが、
#   これが動いている間 iOS は画面に「オートランニング」バナーを出し続ける。
#   本番キオスクではお客様に見えてしまうため、**平時は OFF、操作するときだけ ON** にする。
#   （2026-08-05 ユーザー指示。自動運用は停止済み＝勝手に ON にはならない）
#
# 使い方（ターミナル／tmux から）:
#   ops/ipad/remote-control.sh on          … 遠隔操作を有効化（初回は最大3分）
#   ops/ipad/remote-control.sh shot [path] … 今の画面をPNG保存（既定: ~/Desktop/ipad-<時刻>.png）
#   ops/ipad/remote-control.sh kiosk       … キオスク(Egg Camera)を前面に出す ※要 on
#   ops/ipad/remote-control.sh status      … 現在の状態
#   ops/ipad/remote-control.sh off         … 無効化（バナーが消える）
#
# ★ on は必ず対話シェル（ターミナル/tmux）から実行すること。
#   launchd 経由だとローカルネットワーク権限(TCC)が無く、フォワーダが iPad へ繋げない。
#
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO="/Users/eggcamera/EggCamera"
# zsh は関数内で $0 が関数名になるため、案内文用に呼び出しパスを退避しておく。
SELF="$0"
IPAD_UDID="00008132-001E2934019A401C"
FWD="http://127.0.0.1:18100"
WEBCLIP_HOST="EggCameranoiPad.local"

# iPad の実IPは DHCP で動く。固定値で判断せず mDNS で都度引く（2026-08-04 に .112→.104 と変わった）。
resolve_ipad_ip() {
  local ip
  ip=$(dscacheutil -q host -a name "$WEBCLIP_HOST" 2>/dev/null \
       | awk '/^ip_address:/{print $2}' | grep -E '^192\.168\.' | head -1)
  [[ -z "$ip" ]] && ip=$(grep -oE '192\.168\.[0-9]+\.[0-9]+' "$REPO/ops/ipad/wda-forwarder.js" | head -1)
  print -r -- "$ip"
}

is_up() { curl -s -o /dev/null -m 5 "$FWD/status" 2>/dev/null; }

cmd_status() {
  local ip; ip=$(resolve_ipad_ip)
  print -r -- "iPad IP (mDNS)  : ${ip:-解決できず}"
  if pgrep -f "xcodebuild test-without-building" >/dev/null; then
    print -r -- "WDA(xcodebuild) : 起動中  ← iPad画面に「オートランニング」が出ています"
  else
    print -r -- "WDA(xcodebuild) : 停止    ← バナーなし（平時はこちらが正常）"
  fi
  pgrep -f "wda-forwarder\.js" >/dev/null \
    && print -r -- "フォワーダ      : 起動中" || print -r -- "フォワーダ      : 停止"
  if is_up; then print -r -- "遠隔操作        : ✅ 使える ($FWD)"
  else           print -r -- "遠隔操作        : ❌ 使えない（'$SELF on' で有効化）"; fi
  local conn; conn=$(netstat -an -p tcp 2>/dev/null | grep '\.3000 ' | grep -c "${ip:-__none__}")
  if [[ "$conn" -gt 0 ]]; then
    print -r -- "キオスク画面    : ✅ 生きている（サーバへ${conn}本接続）"
  else
    print -r -- "キオスク画面    : ❌ 閉じている（iPadの「Egg Camera」アイコンをタップ、または '$SELF kiosk'）"
  fi
}

cmd_on() {
  if is_up; then print -r -- "既に有効です。"; cmd_status; return 0; fi
  local ip; ip=$(resolve_ipad_ip)
  [[ -n "$ip" ]] || { print -r -- "❌ iPadのIPを解決できません。iPadの電源とWi-Fiを確認してください。"; return 1; }
  print -r -- "遠隔操作を有効化します（iPad=$ip・最大3分）…"
  print -r -- "※ この間 iPad に「オートランニング」が表示されます。終わったら '$SELF off' で消してください。"
  IPAD_IP="$ip" "$REPO/ops/ipad/wda-wifi-recovery.sh" || { print -r -- "❌ 有効化に失敗しました。"; return 1; }
  cmd_status
}

cmd_off() {
  pkill -f "xcodebuild test-without-building" 2>/dev/null
  pkill -f "wda-forwarder\.js" 2>/dev/null
  sleep 3
  if pgrep -f "xcodebuild test-without-building" >/dev/null; then
    print -r -- "⚠ WDA がまだ残っています。もう一度実行してください。"
  else
    print -r -- "✅ 遠隔操作を無効化しました（iPadの「オートランニング」表示は消えます）"
  fi
}

cmd_shot() {
  is_up || { print -r -- "❌ 先に '$SELF on' で有効化してください。"; return 1; }
  local out="${1:-$HOME/Desktop/ipad-$(date '+%Y%m%d-%H%M%S').png}"
  curl -s -m 20 "$FWD/screenshot" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
open('$out','wb').write(base64.b64decode(d['value']))
" 2>/dev/null && print -r -- "✅ 保存しました: $out" || print -r -- "❌ 取得に失敗しました。"
}

# キオスク(ホーム画面のWebClip)を前面に出す。standalone を保つため Safari では開かない。
cmd_kiosk() {
  is_up || { print -r -- "❌ 先に '$SELF on' で有効化してください。"; return 1; }
  print -r -- "ホーム画面へ戻してキオスクを起動します…"
  curl -s -m 15 -X POST "$FWD/wda/homescreen" -H 'Content-Type: application/json' -d '{}' >/dev/null
  sleep 2
  local sid
  sid=$(curl -s -m 30 -X POST "$FWD/session" -H 'Content-Type: application/json' \
        -d '{"capabilities":{"alwaysMatch":{}}}' \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('value',{}).get('sessionId',''))" 2>/dev/null)
  [[ -n "$sid" ]] || { print -r -- "❌ セッションを作れません。iPadを直接タップしてください。"; return 1; }
  # ホーム画面の「Egg Camera」アイコンを名前で探して押す（座標決め打ちは配置変更に弱い）
  local el
  el=$(curl -s -m 25 -X POST "$FWD/session/$sid/element" -H 'Content-Type: application/json' \
       -d '{"using":"link text","value":"Egg Camera"}' \
       | python3 -c "import sys,json;print(json.load(sys.stdin).get('value',{}).get('ELEMENT',''))" 2>/dev/null)
  if [[ -n "$el" ]]; then
    curl -s -m 20 -X POST "$FWD/session/$sid/element/$el/click" -H 'Content-Type: application/json' -d '{}' >/dev/null
    sleep 6
  fi
  curl -s -m 10 -X DELETE "$FWD/session/$sid" >/dev/null 2>&1
  local ip conn; ip=$(resolve_ipad_ip)
  conn=$(netstat -an -p tcp 2>/dev/null | grep '\.3000 ' | grep -c "${ip:-__none__}")
  if [[ "$conn" -gt 0 ]]; then
    print -r -- "✅ キオスクが復帰しました（接続${conn}本）。'$SELF off' でバナーを消してください。"
  else
    print -r -- "⚠ まだ接続がありません。iPadの画面を直接見て確認してください。"
  fi
}

case "${1:-status}" in
  on)     cmd_on ;;
  off)    cmd_off ;;
  status) cmd_status ;;
  shot)   cmd_shot "${2:-}" ;;
  kiosk)  cmd_kiosk ;;
  *) print -r -- "使い方: $SELF {on|off|status|shot [path]|kiosk}"; exit 1 ;;
esac
