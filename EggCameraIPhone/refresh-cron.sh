#!/bin/zsh
# launchd から毎日呼ばれる。
# ・プロファイル失効が近い(2日以内)/失効済み → refresh（焼き直し＋入れ直し）
# ・まだ余裕がある → restart（落ちていれば起動するだけ。アプリ入れ替えはしない）
# Apple IDアカウントへの接続が要るため GUI ログイン中のユーザーセッションで動かす。
# launchd の PATH は最小なので Homebrew(xcodegen) と Xcode を明示する。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$HOME/Library/Logs/eggcamera-iphone-refresh.log"
cd "$(dirname "$0")" || exit 1

# 失効まで何日を切ったら焼き直すか
RENEW_WITHIN_DAYS=2

profile_expiry_epoch() {
  local newest=0 e f appid exp
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision(N) \
           "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision(N); do
    appid=$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)
    [[ "$appid" == *eggcamera* ]] || continue
    exp=$(security cms -D -i "$f" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null)
    e=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$exp" "+%s" 2>/dev/null) || continue
    (( e > newest )) && newest=$e
  done
  echo "$newest"
}

{
  echo "==== $(date '+%Y-%m-%d %H:%M:%S') check start ===="
  exp=$(profile_expiry_epoch)
  now=$(date +%s)
  if (( exp == 0 )); then
    echo "プロファイルが見つからない → refresh を試行"
    ./iphone.sh refresh && echo "refresh OK" || echo "refresh FAILED"
  else
    days_left=$(( (exp - now) / 86400 ))
    echo "プロファイル失効まで ${days_left} 日"
    if (( exp - now <= RENEW_WITHIN_DAYS * 86400 )); then
      echo "失効が近い → refresh（焼き直し）"
      ./iphone.sh refresh && echo "refresh OK" || echo "refresh FAILED（Xcodeでアカウント確認）"
    else
      echo "余裕あり → restart（起動確認のみ）"
      ./iphone.sh restart && echo "restart OK" || echo "restart FAILED"
    fi
  fi
  echo "==== end ===="
} >> "$LOG" 2>&1
