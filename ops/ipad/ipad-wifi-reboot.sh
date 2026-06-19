#!/bin/zsh
# iPadをWiFi(devicectl/CoreDevice)経由で再起動し、Safari(キオスク)が起動するまで
# `device process launch` を繰り返し送る。**launch成功＝iPad復帰＝再起動完了** とみなす。
# 本番(USB無し・WiFiのみ/transportType localNetwork)で動作。sudo不要。
#
# 背景: WiFiでは再起動完了の検知が devicectl/ping ともキャッシュで当てにならない([[ipad-wifi-reboot]])。
# そこで「実際のSafari起動が通ったこと」を完了シグナルにする(ユーザ案 2026-06-19)。
# 誤検知防止: 一度 launch が失敗(=ダウン)してから成功したものだけを「再起動完了」と認める
# (再起動前のまだ生きているiPadへの launch 成功を完了と誤判定しないため)。
#
# usbmux/appium-tunnel は本番に不要。これはWiFi本番運用の再起動フロー。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

IPAD="00008132-001E2934019A401C"
URL="http://192.168.10.104:3000/"
SAFARI="com.apple.mobilesafari"
MARK="http://127.0.0.1:3000/api/test-report"
POLL=12                 # 試行間隔(秒)
MAX=$((7*60))           # 最大待機(秒)
LAUNCH_TIMEOUT=20       # 各 launch のタイムアウト(秒)

mark(){ curl -s -m8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data "$(printf '{"level":"%s","text":"DEPLOY-MARKER(ipad-wifi-reboot): %s"}' "$1" "$2")" >/dev/null 2>&1; }

echo "==== $(date '+%F %T') iPad WiFi再起動 開始 ===="

# appium長期テスト中はdevicectl rebootが競合して不安定なので中止。
# 実際の `node …ipad-test.js` だけを検出する(3つの誤検知を回避):
#  ① post-boot-claude復旧Claudeのプロンプト本文に "ipad-test.js" "node" が散在 → コマンドに
#     dangerously-skip-permissions を含むプロセス(=claude)を除外。
#  ② プロンプトが多行のため grep の行単位除外では漏れる → PID単位で全コマンドを平坦化して判定。
#  ③ pgrep 自身の引数で自己マッチ → 正規表現 `[i]pad-test` で回避。
running_ipad_test() {
  local pid cmd
  for pid in $(pgrep -f '[i]pad-test\.js' 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null | tr '\n' ' ')
    case "$cmd" in
      (*dangerously-skip-permissions*) continue ;;   # claude復旧エージェントを除外
      (*node*ipad-test.js*) return 0 ;;               # 実テスト
    esac
  done
  return 1
}
if running_ipad_test; then
  echo "⚠ node ipad-test.js 実行中 → 競合回避のため中止"; mark alert "ipad-test.js実行中のため再起動中止"; exit 2
fi

mark info "iPad WiFi再起動開始(USB無し本番フロー)。Safari起動成功をもって完了とみなす。撮影断は本作業由来で異常ではない。"
echo "[1] WiFi再起動(devicectl)送信"
xcrun devicectl device reboot --device "$IPAD" --timeout 30 2>&1 | grep -iE 'reboot|requested|error' | head -1

echo "[2] Safari起動を試行し続ける(間隔${POLL}s・最大$((MAX/60))分・ダウン後の成功で完了)"
seen_down=0; t=0; done=0
while [ "$t" -lt "$MAX" ]; do
  sleep "$POLL"; t=$((t+POLL))
  if xcrun devicectl device process launch --device "$IPAD" "$SAFARI" \
        --payload-url "$URL" --timeout "$LAUNCH_TIMEOUT" >/dev/null 2>&1; then
    if [ "$seen_down" = 1 ]; then
      echo "  ✅ ${t}s: Safari起動成功(ダウン後) = iPad再起動完了"
      done=1; break
    else
      echo "  ${t}s: launch成功だが未ダウン(再起動前/開始待ち) → 継続"
    fi
  else
    [ "$seen_down" = 0 ] && echo "  ${t}s: launch失敗 = iPadダウン検知(再起動進行中)"
    seen_down=1
  fi
done

if [ "$done" = 1 ]; then
  echo "==== $(date '+%F %T') ✅ 完了: 再起動+Safari(キオスク)起動OK (${t}s) ===="
  mark info "iPad WiFi再起動+Safari起動 完了(${t}s)。キオスク復帰。"
  exit 0
else
  echo "==== $(date '+%F %T') ⚠ 未完了(seen_down=$seen_down, ${MAX}s) ===="
  if [ "$seen_down" = 0 ]; then
    mark alert "iPad WiFi再起動 未完了: ダウンを一度も検知せず=reboot不発の可能性。要確認。"
  else
    mark alert "iPad WiFi再起動 未完了: ダウンは検知したがSafari起動に至らず(${MAX}s)。要確認。"
  fi
  exit 1
fi
