#!/bin/zsh
#
# after-boot-check.sh — Mac mini を手動で起動した後／ネットワークを変えた後の点検。
#
# 使い方（ターミナルにコピペするだけ）:
#   ~/EggCamera/ops/after-boot-check.sh              … 点検だけ（何も変更しない）
#   ~/EggCamera/ops/after-boot-check.sh --fix-kiosk  … iPadのキオスク画面を強制的に読み直す
#
# Claude なしで人間だけで使えるように、判定と「次にやること」を日本語で出す。
#
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO="/Users/eggcamera/EggCamera"
IPAD_UDID="00008132-001E2934019A401C"
IPAD_IP="192.168.11.104"          # iPadのWi-Fi IP（変わったらここも直す）
SAFARI="com.apple.mobilesafari"

FIX_KIOSK=0
[[ "${1:-}" == "--fix-kiosk" ]] && FIX_KIOSK=1

ng=0
ok()   { print -r -- "  ✅ $1"; }
bad()  { print -r -- "  ❌ $1"; ng=$((ng+1)); }
warn() { print -r -- "  ⚠️  $1"; }

print -r -- "════════════════════════════════════════════════"
print -r -- " EggCamera 起動後チェック  $(date '+%Y-%m-%d %H:%M')"
print -r -- "════════════════════════════════════════════════"

# ── 1. MacのIP（キオスクURLに使う有線側） ─────────────────
print -r -- ""
print -r -- "【1】Mac の IP"
# 有線IFは機器構成で変わる（2026-08-04: USBアダプタ en8 → 内蔵 en0 へ移行）。
# デフォルト経路が載っているIFを本番IFとみなし、Wi-Fi(en1)だけは除外する。
WIRED_IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
[[ "$WIRED_IF" == "en1" ]] && WIRED_IF=""
if [[ -z "$WIRED_IF" ]]; then
  for i in en0 en8; do
    [[ -n "$(ipconfig getifaddr $i 2>/dev/null)" ]] && { WIRED_IF=$i; break; }
  done
fi
WIRED=$(ipconfig getifaddr "${WIRED_IF:-en0}" 2>/dev/null)
WIFI=$(ipconfig getifaddr en1 2>/dev/null)
print -r -- "  有線(${WIRED_IF:-不明})= ${WIRED:-なし}   Wi-Fi(en1)= ${WIFI:-なし}  ← キオスクURLは有線側を使う"
URL_IN_SCRIPT=$(grep -oE 'http://192\.168\.[0-9]+\.[0-9]+:3000' "$REPO/ops/ipad/ipad-wifi-reboot.sh" 2>/dev/null | head -1)
KIOSK_IP=$(print -r -- "$URL_IN_SCRIPT" | sed -E 's|http://([0-9.]+):3000|\1|')
if [[ -z "$WIRED" ]]; then
  bad "有線IFにIPが無い。LANケーブル／USB-Ethernetアダプタが抜けていないか確認"
elif [[ "$WIRED" == "$KIOSK_IP" ]]; then
  ok "設定ファイルのキオスクURL($URL_IN_SCRIPT)と一致している"
else
  bad "不一致！ 設定は $KIOSK_IP だが実際は $WIRED → 手順書の「3. IPが変わった場合」を実行"
fi

# ── 2. サーバ ────────────────────────────────────────────
print -r -- ""
print -r -- "【2】サーバ（Mac mini の中）"
code() { curl -s -o /dev/null -m5 -w '%{http_code}' "$1" 2>/dev/null || print -n 000; }
[[ "$(code http://127.0.0.1:3000/)" == 200 ]] && ok "撮影サーバ(:3000) 動作中" || bad "撮影サーバ(:3000) 応答なし"
[[ "$(code http://127.0.0.1:8080/frame)" == 200 ]] && ok "iPhoneカメラ(:8080) 映像OK" || bad "iPhoneカメラ(:8080) 応答なし → iPhoneのUSBと EggCameraアプリを確認"
for s in node admin appium iproxy bot mac; do
  if launchctl list 2>/dev/null | awk -v n="com.eggcamera.$s" '$3==n && $1!="-"{f=1} END{exit !f}'; then
    ok "常駐 $s 起動中"
  else
    bad "常駐 $s が起動していない → sudo launchctl kickstart -k gui/\$(id -u)/com.eggcamera.$s"
  fi
done

# ── 3. iPad ──────────────────────────────────────────────
print -r -- ""
print -r -- "【3】iPad（キオスク端末）"
info=$(xcrun devicectl device info details --device "$IPAD_UDID" 2>/dev/null)
print -r -- "$info" | grep -qi 'bootState:.*booted'      && ok "電源ON" || bad "iPadが見えない → USBを挿し直し、画面を触って起こす"
print -r -- "$info" | grep -qi 'tunnelState:.*connected' && ok "Macと接続OK" || warn "Macとのトンネル未接続（USBを挿し直すと直ることが多い）"
if ping -c1 -W900 "$IPAD_IP" >/dev/null 2>&1; then
  ok "Wi-Fi疎通OK ($IPAD_IP)"
else
  bad "Wi-Fiで $IPAD_IP に届かない → iPadのWi-Fi設定を確認（IPが変わった可能性）"
fi

# ── 4. キオスク画面が生きているか ────────────────────────
print -r -- ""
print -r -- "【4】キオスク画面（★Mac再起動後はここが死んでいることが多い）"
KURL="http://${WIRED:-127.0.0.1}:3000/"
[[ "$(code "$KURL")" == 200 ]] && ok "キオスクURL $KURL が配信OK" || bad "キオスクURLが配信されていない"
# 画面の中身(JS)が揃っているか＝白画面の防止
html=$(curl -s -m5 "$KURL" 2>/dev/null)
miss=0
for a in $(print -r -- "$html" | grep -oE '\./assets/[^"]*\.(js|css)' | sed 's|^\.||'); do
  [[ "$(code "http://${WIRED}:3000$a")" == 200 ]] || { miss=1; }
done
[[ "$miss" == 0 ]] && ok "画面の部品(JS/CSS)も揃っている" || bad "画面の部品が欠けている＝iPadが白画面になる"
# iPadが実際に繋いでいるか（アプリはSSEで常時2本ほど張る。0本が続く＝画面が死んでいる）
conn=$(netstat -an -p tcp 2>/dev/null | grep '\.3000 ' | grep -c "$IPAD_IP")
if [[ "$conn" -gt 0 ]]; then
  ok "iPadがサーバに接続中（${conn}本）＝画面は生きている"
else
  bad "iPadからの接続が0本＝キオスク画面が死んでいる可能性が高い"
  print -r -- "     → 直すには:  $0 --fix-kiosk"
fi

# ── 5. 運用フラグ ────────────────────────────────────────
print -r -- ""
print -r -- "【5】運用フラグ（古いまま残っていないか）"
[[ -f "$REPO/ops/ipad/.wda-wifi-mode"  ]] && warn "'.wda-wifi-mode' あり（iPadがUSB接続なら消してよい: rm $REPO/ops/ipad/.wda-wifi-mode）" || ok "wda-wifi-mode なし"
if [[ -f "$REPO/ops/ipad/.ipad-down-until" ]]; then
  warn "'.ipad-down-until' あり（$(cat "$REPO/ops/ipad/.ipad-down-until")）→ iPadが直ったら消す: rm $REPO/ops/ipad/.ipad-down-until"
else
  ok "ipad-down-until なし"
fi

# ── キオスク強制リロード ─────────────────────────────────
if [[ "$FIX_KIOSK" == 1 ]]; then
  print -r -- ""
  print -r -- "【修復】キオスク画面を読み直します"
  # ※ launch だけでは「前面に出すだけ」で読み直さない。必ず一度終了させる。
  pid=$(xcrun devicectl device info processes --device "$IPAD_UDID" 2>/dev/null \
        | grep -i 'MobileSafari.app/MobileSafari' | awk '{print $1}' | head -1)
  if [[ -n "$pid" ]]; then
    xcrun devicectl device process terminate --device "$IPAD_UDID" --pid "$pid" >/dev/null 2>&1
    print -r -- "  Safari(PID $pid) を終了しました"
    sleep 3
  fi
  if xcrun devicectl device process launch --device "$IPAD_UDID" "$SAFARI" \
       --payload-url "$KURL" --timeout 30 >/dev/null 2>&1; then
    print -r -- "  Safari を $KURL で起動しました"
  else
    print -r -- "  ❌ Safari の起動に失敗。iPadの画面を直接タップして操作してください"
  fi
  sleep 8
  conn=$(netstat -an -p tcp 2>/dev/null | grep '\.3000 ' | grep -c "$IPAD_IP")
  [[ "$conn" -gt 0 ]] && print -r -- "  ✅ 復旧しました（接続${conn}本）" \
                      || print -r -- "  ⚠️  まだ接続がありません。iPadの画面を直接見て確認してください"
fi

# ── まとめ ───────────────────────────────────────────────
print -r -- ""
print -r -- "════════════════════════════════════════════════"
if [[ "$ng" == 0 ]]; then
  print -r -- " 結果: 問題なし ✅"
  print -r -- " 最後に iPadの画面を目で見て、くまの絵と「はじめる」が出ていればOK"
else
  print -r -- " 結果: 要対応が ${ng} 件 ❌"
  print -r -- " 上の ❌ の行に書かれた対処を上から順に実行してください"
  print -r -- " 手順書: $REPO/ops/manual-shutdown-boot-network-change.md"
fi
print -r -- "════════════════════════════════════════════════"
exit 0
