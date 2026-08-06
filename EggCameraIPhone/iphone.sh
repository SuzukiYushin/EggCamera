#!/bin/zsh
# iPhone カメラアプリを Xcode CLI でビルド/インストール/再起動する。
# 接続中のデバイスを自動検出するので DEVICE_ID を毎回直す必要はない。
#
# 使い方:
#   ./iphone.sh restart     # 起動中のアプリを再起動（ビルドなし・最速）
#   ./iphone.sh run         # ビルド→インストール→起動（コード変更後はこれ）
#   ./iphone.sh build       # ビルドのみ
#   ./iphone.sh install     # ビルド済み .app を再インストール
#   ./iphone.sh launch      # 起動するだけ
#   ./iphone.sh status      # 接続デバイスとアプリの確認
#
# 署名チーム/対象を上書きするとき:
#   DEVELOPMENT_TEAM=XXXX ./iphone.sh run
set -euo pipefail
cd "$(dirname "$0")"

SCHEME='EggCameraIPhone'
PROJECT='EggCameraIPhone.xcodeproj'
BUILD_DIR='.build'
APP="$BUILD_DIR/Build/Products/Debug-iphoneos/$SCHEME.app"
BUNDLE_ID='com.siggaze.eggcamera'
# プロファイル「iOS Team Provisioning Profile: com.siggaze.eggcamera」のチーム。
# 署名証明書は siggaze.0000@gmail.com (6FKKW68VQ4) が使われるが、チーム指定はこちら。
# 2026-07-27: 個人チーム(4U78CNU7WN, 無料・7日失効)→FAMILIAR,LTD.(有料・1年プロファイル)へ移行。
# チーム変更時は同一bundle IDでも上書きインストールが無言で弾かれるため、アンインストール→再インストールが必要。
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-LS9YJ4SY5W}"

# ── ビルド番号(CFBundleVersion)を毎ビルドで単調増加させる ─────────────
# 【重要・2026-07-04障害の恒久策】CFBundleVersion が固定("1")だと、iOS/cfgutil は
# 「同一バージョン＝変更なし」とみなしバイナリを実際に置き換えない no-op install になる。
# その結果コード変更がデバイスに反映されず（プロセス再起動しても旧バイナリ）、原因究明で
# アンインストール→無料署名の信頼喪失→撮影停止、という二次被害に至った。
# 対策: xcodegen generate の前に project.yml の CFBundleVersion を単調増加値へ書き換える。
# 信頼済みの既存アプリへ「更新」として入るため、同一開発者は再信頼不要でトラストも保たれる。
bump_build_number() {
  local pj="project.yml"
  local cur new
  cur=$(grep -E '^\s*CFBundleVersion:' "$pj" | grep -oE '[0-9]+' | head -1)
  new=$(( ${cur:-0} + 1 ))
  # macOS sed（BSD）: インプレース編集。数値のみを差し替える。
  sed -i '' -E "s/(CFBundleVersion:[[:space:]]*\")[0-9]+(\")/\1${new}\2/" "$pj"
  echo "▶ CFBundleVersion ${cur:-?} → ${new}（no-op install 回避）"
}

# ── 接続デバイスを自動検出 ───────────────────────────────
# devicectl 用の識別子（install/launch）と xcodebuild 用の UDID（build）を取る。
# ★必ず iPhone を選ぶ: テスト用 iPad(EggCameraのiPad) も同時接続されており、
#   無条件に「最初の1台」を取ると iPad を掴んでしまう（reboot/refresh が誤爆）。
#   名前/機種に "iPhone" を含む行だけに絞る。
# ★状態列で判定しない（2026-08-06修正）: `list devices` の状態は接続経路によって
#   "connected" ではなく "available (paired)" のままのことがあり、その状態でも
#   device info/reboot は正常に通る。旧実装は "connected" を必須にしていたため
#   実際には使えるiPhoneを「見つからない」と誤判定し、週次再起動が無音で失敗していた。
#   一覧は候補出しに留め、採否は `device info details` の tunnelState=connected で決める。
detect_device() {
  if [[ -n "${DEVICE_CORE_ID:-}" ]]; then
    CORE_ID="$DEVICE_CORE_ID"
  else
    # ★判定に `| grep -q` を使わないこと（2026-08-06に実害）。このスクリプトは
    #   `set -euo pipefail` なので、grep -q が最初の一致で即終了すると xcrun に SIGPIPE が飛び、
    #   pipefail によってパイプ全体が非ゼロ＝「一致しなかった」と誤判定される。成否が出力量と
    #   タイミングで変わるため、接続できているのに散発的に「iPhoneが見つかりません」となり、
    #   週次再起動が無音で中止されていた。出力を変数に取り、パイプなしで判定する。
    CORE_ID=""
    local cand try det
    for try in 1 2 3; do
      for cand in $(xcrun devicectl list devices 2>/dev/null \
          | awk -F'  +' '/iPhone/ && !/unavailable/ {print $3}'); do
        det=$(xcrun devicectl device info details --device "$cand" 2>/dev/null) || det=""
        if [[ "$det" =~ 'tunnelState:[[:space:]]*connected' ]]; then
          CORE_ID="$cand"; break 2
        fi
      done
      [ "$try" -lt 3 ] && { echo "  iPhoneの応答待ち（$try/3）…" >&2; sleep 5; }
    done
  fi
  BUILD_UDID="${DEVICE_UDID:-$(xcrun xctrace list devices 2>/dev/null \
    | grep -i 'iPhone' \
    | sed -n 's/.*(\([0-9A-Fa-f]\{8\}-[0-9A-Fa-f]\{16\}\))$/\1/p' | head -1 || true)}"
  if [[ -z "${CORE_ID:-}" ]]; then
    echo "ERROR: 応答するiPhoneが見つかりません（一覧に出ていても tunnelState が connected でない）。" >&2
    echo "       確認: xcrun devicectl list devices / xcrun devicectl device info details --device <id>" >&2
    exit 1
  fi
}

# アプリ再起動直後は初回撮影が 12MP cold-start race を踏む。node(:3000)に捨て撮り
# ウォームアップを依頼し、実客より先に「最初の1枚」を吸収させる（応答は即返る＝待たない）。
# node停止中/未起動でも本処理は止めない（boot時は server.js 側の warmup が肩代わり）。
trigger_warmup() {
  local env_file="../EggCameraNode/.env"
  local token=""
  [[ -f "$env_file" ]] && token="$(grep -E '^ADMIN_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"')"
  echo "▶ node に捨て撮りウォームアップを依頼（cold-start吸収）"
  curl -s -m 3 -o /dev/null \
    -X POST "http://127.0.0.1:3000/api/admin/warmup" \
    -H "Content-Type: application/json" \
    ${token:+-H "X-Admin-Token: $token"} \
    --data '{"reason":"iphone-relaunch"}' 2>/dev/null || true
}

cmd_build() {
  detect_device
  echo "▶ ビルド (team=$DEVELOPMENT_TEAM, udid=${BUILD_UDID:-name指定})"
  bump_build_number
  xcodegen generate >/dev/null
  local dest
  if [[ -n "${BUILD_UDID:-}" ]]; then dest="platform=iOS,id=$BUILD_UDID"; else dest="generic/platform=iOS"; fi
  # -allowProvisioningUpdates は付けない。CLIからはXcodeのApple IDアカウントが
  # 見えず "No Accounts" で失敗するため。代わりにXcodeが生成済みの管理プロファイルを
  # そのまま使う（失効・端末追加時はXcodeを一度開いて更新すること）。
  xcodebuild \
    -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
    -destination "$dest" -derivedDataPath "$BUILD_DIR" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic \
    build
}

cmd_install() {
  detect_device
  # ★監督下デバイスには cfgutil で「管理対象アプリ」として配信する。
  #   devicectl(sideload) だと監督化の恩恵を受けられず、再起動後に開発者証明書の
  #   手動信頼が必要になり、カメラが自動復帰しない（2026-06-18の障害）。
  #   cfgutil 経由（管理対象）なら手動信頼不要＝再起動耐性あり。検証済み。
  local CFG=/usr/local/bin/cfgutil ECID=""
  if [[ -x "$CFG" ]]; then
    ECID=$("$CFG" list 2>/dev/null | grep -i 'Type: iPhone' | grep -oE 'ECID: [0-9A-Fx]+' | head -1 | awk '{print $2}')
  fi
  if [[ -n "$ECID" ]]; then
    echo "▶ インストール（cfgutil・管理対象/監督下） → ECID $ECID"
    "$CFG" --ecid "$ECID" install-app "$APP"
  else
    echo "⚠ cfgutil/ECID取得不可 → devicectl フォールバック（再起動後に手動信頼が要る場合あり）" >&2
    echo "▶ インストール（devicectl） → $CORE_ID"
    xcrun devicectl device install app --device "$CORE_ID" "$APP"
  fi
}

cmd_launch() {
  detect_device
  echo "▶ 起動（既存プロセスは終了して入れ替え）"
  # 再インストール直後の1回目は iOS 側の LaunchServices が古い情報を持っていて
  # LaunchServicesDataMismatch で必ず弾かれることがある。2回目以降は通るので、
  # 1回失敗しただけで諦めない（2026-07-29〜31 は毎朝ここで諦め、カメラが
  # 9:50 の watchdog に拾われるまで約5時間停止していた）。
  for i in 1 2 3; do
    if xcrun devicectl device process launch --terminate-existing --device "$CORE_ID" "$BUNDLE_ID"; then
      trigger_warmup
      return 0
    fi
    echo "  起動に失敗（$i/3）→ 5秒待って再試行"
    sleep 5
  done
  echo "⚠ 3回試しても起動できなかった" >&2
  return 1
}

# iPhone本体を再起動 → 復帰を待つ → アプリを起動。
# 注意: iOSは再起動後にアプリを自動起動しない（ここで起動する）。
#       iPhoneにパスコードがあると再起動後ロックされ、解除するまでアプリが使えない。
#       キオスク機はパスコード無し（またはガイドアクセス）にしておくこと。
cmd_reboot() {
  detect_device
  echo "▶ iPhone本体を再起動（--wait-for-device で復帰待ち）"
  # ★失敗を握りつぶさない（2026-08-06修正）: 旧実装は `|| true` で devicectl の失敗を捨て、
  #   さらに起動ループが6回全滅しても 0 を返していた。呼び出し側(週次再起動)は終了ステータスで
  #   Mac再起動の可否を判断するため、ここが常に0だと「再起動できていないのに合格」になる。
  if ! xcrun devicectl device reboot --device "$CORE_ID" --wait-for-device --timeout 180; then
    echo "ERROR: devicectl device reboot に失敗（本体は再起動できていない）" >&2
    return 1
  fi
  echo "▶ 復帰後、アプリを起動"
  # 再起動直後はサービスが立ち上がるまで数回リトライ
  local launched=0
  for i in 1 2 3 4 5 6; do
    if xcrun devicectl device process launch --terminate-existing --device "$CORE_ID" "$BUNDLE_ID" 2>/dev/null; then
      echo "アプリ起動OK"; trigger_warmup; launched=1; break
    fi
    echo "  起動待ち… ($i)"; sleep 10
  done
  if [[ "$launched" != 1 ]]; then
    echo "ERROR: 本体は再起動したがアプリを起動できず（6回試行）" >&2
    return 1
  fi
}

# プロファイル更新を伴う再ビルド（週次の自動更新用）。
# -allowProvisioningUpdates で失効前のプロファイルを焼き直し、入れ直して起動する。
# Apple IDアカウントに接続するため、GUIログイン中のセッションで実行すること。
cmd_refresh() {
  detect_device
  echo "▶ プロファイル更新つき再ビルド (team=$DEVELOPMENT_TEAM)"
  bump_build_number
  xcodegen generate >/dev/null
  local dest
  if [[ -n "${BUILD_UDID:-}" ]]; then dest="platform=iOS,id=$BUILD_UDID"; else dest="generic/platform=iOS"; fi
  xcodebuild \
    -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
    -destination "$dest" -derivedDataPath "$BUILD_DIR" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates build
  cmd_install
  cmd_launch
}

cmd_status() {
  # 状態列は "connected" とは限らない（available (paired) でも通信可）。unavailable以外を全部見せる。
  echo "=== 認識中のデバイス（unavailable以外・状態列は当てにしない）==="
  xcrun devicectl list devices 2>/dev/null | grep -viE '^$|^Devices|^-+|unavailable' || echo "なし"
  detect_device
  echo "core-id=$CORE_ID / build-udid=${BUILD_UDID:-?} / bundle=$BUNDLE_ID / team=$DEVELOPMENT_TEAM"
}

case "${1:-run}" in
  build)   cmd_build ;;
  install) cmd_install ;;
  launch)  cmd_launch ;;
  restart) cmd_launch ;;                       # アプリ再起動（ビルドせず）
  reboot)  cmd_reboot ;;                        # iPhone本体を再起動→アプリ起動
  run)     cmd_build && cmd_install && cmd_launch ;;
  refresh) cmd_refresh ;;                      # 週次の自動更新用（プロファイル焼き直し）
  status)  cmd_status ;;
  *) echo "usage: ./iphone.sh {run|build|install|launch|restart|reboot|refresh|status}" >&2; exit 1 ;;
esac
