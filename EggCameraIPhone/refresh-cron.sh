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

# Slack 通知（Webhook URL は ~/EggCamera/.env.slack に置く・git管理外）
#   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
notify_slack() {
  local msg="$1"
  local url=""
  [[ -f "$HOME/EggCamera/.env.slack" ]] && url=$(grep -m1 '^SLACK_WEBHOOK_URL=' "$HOME/EggCamera/.env.slack" | cut -d= -f2-)
  [[ -z "$url" ]] && { echo "（Slack未設定のため通知スキップ）"; return; }
  local host; host=$(scutil --get ComputerName 2>/dev/null || hostname)
  curl -sS -m 10 -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\":warning: *EggCamera iPhone署名* (${host})\n${msg}\"}" "$url" >/dev/null \
    && echo "Slack通知 送信" || echo "Slack通知 失敗"
}

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
    if ./iphone.sh refresh; then echo "refresh OK"
    else echo "refresh FAILED"; notify_slack "プロファイルが見つからず再生成にも失敗しました。アプリが起動しない恐れ。Xcodeでサインイン状態を確認してください。"; fi
  else
    days_left=$(( (exp - now) / 86400 ))
    echo "プロファイル失効まで ${days_left} 日"
    if (( exp - now <= RENEW_WITHIN_DAYS * 86400 )); then
      echo "失効が近い → refresh（焼き直し）"
      if ./iphone.sh refresh; then
        echo "refresh OK"
        # 焼き直し後も失効が更新されていなければ（=再生成できていない）通知
        newexp=$(profile_expiry_epoch)
        if (( newexp <= now )); then
          notify_slack "プロビジョニングが失効し、自動更新できませんでした。手動でXcodeを開いて更新してください。"
        elif (( newexp - now <= RENEW_WITHIN_DAYS * 86400 )); then
          echo "（注意）失効日が更新されていない可能性。次回再試行。"
        fi
      else
        echo "refresh FAILED"
        notify_slack "プロビジョニングの自動更新に失敗しました（残り ${days_left} 日）。期限切れでアプリが止まる前にXcodeで更新してください。"
      fi
    else
      echo "余裕あり → restart（起動確認のみ）"
      ./iphone.sh restart && echo "restart OK" || { echo "restart FAILED"; notify_slack "アプリの起動確認に失敗しました。iPhoneの接続/状態を確認してください。"; }
    fi
  fi
  # 念のため: 現時点で既に失効しているのに上で拾えていなければ通知
  finalexp=$(profile_expiry_epoch)
  if (( finalexp != 0 && finalexp <= now )); then
    notify_slack "プロビジョニングが失効中です。アプリが起動できない可能性があります。"
  fi
  echo "==== end ===="
} >> "$LOG" 2>&1
