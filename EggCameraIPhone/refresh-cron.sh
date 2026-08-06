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

# 長期運用テストの監視（別セッション）向け設定
TEST_REPORT_URL="http://localhost:3000/api/test-report"
# USB(iproxy)経由: iPhone:8080 は localhost:8080 に転送される（旧WiFi直IPは廃止）
IPHONE_FRAME_URL="${IPHONE_FRAME_URL:-http://127.0.0.1:8080/frame}"

# 監視ログに DEPLOY-MARKER を投稿（このジョブによるアプリ再起動を「申し送り」扱いにさせる）
post_marker() {
  local text="$1"
  curl -s -m 8 -X POST "$TEST_REPORT_URL" -H 'Content-Type: application/json' \
    --data "{\"level\":\"info\",\"text\":\"DEPLOY-MARKER(iphone-refresh): ${text}\"}" >/dev/null 2>&1 \
    && echo "marker投稿OK" || echo "marker投稿失敗(監視サーバ未起動?)"
}

# 再デプロイ完了の必須確認: iPhoneが :8080/frame を200で返す状態に戻ったか
verify_iphone_up() {
  local code i
  for i in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" "$IPHONE_FRAME_URL" 2>/dev/null || echo 000)
    [[ "$code" == 200 ]] && { echo "iPhone :8080/frame=200（復旧確認）"; return 0; }
    sleep 5
  done
  echo "iPhone :8080/frame=${code}（200に戻らず）"
  return 1
}

# Slack 通知（Webhook URL は ~/EggCamera/.env.slack に置く・git管理外）
#   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
# アクション種別タグ（受信者が「何をすべきか」を一目で判断できるよう先頭に出す）
slack_tag() { # action(none/fix/restart/investigate)
  case "$1" in
    none)    echo ":white_check_mark: *通知：対処不要*" ;;
    fix)     echo ":wrench: *要修正：コード/設定を確認*" ;;
    restart) echo ":electric_plug: *要再起動／物理操作*" ;;
    *)       echo ":mag: *要調査：原因を確認*" ;;
  esac
}
notify_slack() { # action msg
  local action="$1" msg="$2"
  local url=""
  [[ -f "$HOME/EggCamera/.env.slack" ]] && url=$(grep -m1 '^SLACK_WEBHOOK_URL=' "$HOME/EggCamera/.env.slack" | cut -d= -f2-)
  [[ -z "$url" ]] && { echo "（Slack未設定のため通知スキップ）"; return; }
  local host; host=$(scutil --get ComputerName 2>/dev/null || hostname)
  curl -sS -m 10 -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"$(slack_tag "$action")\n:warning: *EggCamera iPhone署名* (${host})\n${msg}\"}" "$url" >/dev/null \
    && echo "Slack通知 送信" || echo "Slack通知 失敗"
}

profile_expiry_epoch() {
  local newest=0 e f appid exp
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision(N) \
           "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision(N); do
    appid=$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)
    # Xcode の自動署名が作るのはワイルドカード（"TEAMID.*"）のチーム用プロファイルで、
    # バンドルIDは入らない。eggcamera 名での一致だけを見ていたため常に「見つからない」と
    # 判定され、有効期限が1年あるのに毎朝フルビルド＋再インストールしていた
    # （その再インストールが LaunchServicesDataMismatch を誘発し、カメラ停止の原因になっていた）。
    [[ "$appid" == *eggcamera* || "$appid" == *.\* ]] || continue
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
  did_redeploy=0   # アプリを再起動/再インストールしたら1
  if (( exp == 0 )); then
    echo "プロファイルが見つからない → refresh を試行"
    post_marker "iPhoneアプリを再ビルド・再インストール・再起動します（プロファイル無し→再生成）。数サイクルのcapture_timeout/プレビュー断は本作業由来で異常ではありません。"
    did_redeploy=1
    if ./iphone.sh refresh; then echo "refresh OK"
    else echo "refresh FAILED"; notify_slack fix "プロファイルが見つからず再生成にも失敗しました。アプリが起動しない恐れ。Xcodeでサインイン状態を確認してください。"; fi
  else
    days_left=$(( (exp - now) / 86400 ))
    echo "プロファイル失効まで ${days_left} 日"
    if (( exp - now <= RENEW_WITHIN_DAYS * 86400 )); then
      echo "失効が近い → refresh（焼き直し）"
      post_marker "プロビジョニング失効間近のためiPhoneアプリを再ビルド・再インストール・再起動します。数サイクルのcapture_timeout/プレビュー断は本作業由来で異常ではありません。"
      did_redeploy=1
      if ./iphone.sh refresh; then
        echo "refresh OK"
        newexp=$(profile_expiry_epoch)
        if (( newexp <= now )); then
          notify_slack fix "プロビジョニングが失効し、自動更新できませんでした。手動でXcodeを開いて更新してください。"
        elif (( newexp - now <= RENEW_WITHIN_DAYS * 86400 )); then
          echo "（注意）失効日が更新されていない可能性。次回再試行。"
        fi
      else
        echo "refresh FAILED"
        notify_slack fix "プロビジョニングの自動更新に失敗しました（残り ${days_left} 日）。期限切れでアプリが止まる前にXcodeで更新してください。"
      fi
    else
      echo "余裕あり → restart（起動確認のみ）"
      post_marker "iPhoneアプリの起動確認のため再起動します（プロファイルは有効）。一時的なプレビュー断は本作業由来で異常ではありません。"
      did_redeploy=1
      ./iphone.sh restart && echo "restart OK" || { echo "restart FAILED"; notify_slack restart "アプリの起動確認に失敗しました。iPhoneの接続/状態を確認してください。"; }
    fi
  fi

  # 再デプロイした場合は :8080 が200に戻ったことを必ず確認し、結果をマーカーで申し送る
  if (( did_redeploy )); then
    if ! verify_iphone_up; then
      # ここで諦めるとカメラが落ちたまま朝まで放置される（2026-07-29〜31 は毎朝
      # 約5時間停止し、9:50のwatchdogが拾うまで撮影不能だった）。インストール自体は
      # 成功していて起動だけが失敗しているケースが大半なので、起動をやり直す。
      echo "起動できていない → launch をやり直して復旧を試みる"
      for i in 1 2; do
        ./iphone.sh launch || true
        verify_iphone_up && break
        echo "  復旧できず（$i/2）"
      done
    fi
    if verify_iphone_up; then
      post_marker "iPhone再デプロイ完了。:8080/frame=200 で復旧確認済み。以降は正常稼働。"
    else
      post_marker "iPhone再デプロイ後、:8080/frame が200に戻りません。撮影系が止まっている可能性。要確認。"
      notify_slack restart "iPhone再デプロイ後にアプリが :8080 を返しません。撮影が止まっている可能性があります。"
    fi
  fi

  finalexp=$(profile_expiry_epoch)
  if (( finalexp != 0 && finalexp <= now )); then
    notify_slack fix "プロビジョニングが失効中です。アプリが起動できない可能性があります。"
  fi
  echo "==== end ===="
} >> "$LOG" 2>&1
