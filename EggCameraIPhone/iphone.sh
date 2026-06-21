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
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-4U78CNU7WN}"

# ── 接続デバイスを自動検出 ───────────────────────────────
# devicectl 用の識別子（install/launch）と xcodebuild 用の UDID（build）を取る。
# ★必ず iPhone を選ぶ: テスト用 iPad(EggCameraのiPad) も同時接続されており、
#   無条件に「最初の connected」を取ると iPad を掴んでしまう（reboot/refresh が誤爆）。
#   名前/機種に "iPhone" を含む行だけに絞る。
detect_device() {
  CORE_ID="${DEVICE_CORE_ID:-$(xcrun devicectl list devices 2>/dev/null \
    | awk -F'  +' '/connected/ && /iPhone/ {print $3; exit}')}"
  BUILD_UDID="${DEVICE_UDID:-$(xcrun xctrace list devices 2>/dev/null \
    | grep -i 'iPhone' \
    | sed -n 's/.*(\([0-9A-Fa-f]\{8\}-[0-9A-Fa-f]\{16\}\))$/\1/p' | head -1)}"
  if [[ -z "${CORE_ID:-}" ]]; then
    echo "ERROR: 接続中のiPhoneが見つかりません。USB接続とロック解除を確認してください。" >&2
    exit 1
  fi
}

cmd_build() {
  detect_device
  echo "▶ ビルド (team=$DEVELOPMENT_TEAM, udid=${BUILD_UDID:-name指定})"
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
  xcrun devicectl device process launch --terminate-existing --device "$CORE_ID" "$BUNDLE_ID"
}

# iPhone本体を再起動 → 復帰を待つ → アプリを起動。
# 注意: iOSは再起動後にアプリを自動起動しない（ここで起動する）。
#       iPhoneにパスコードがあると再起動後ロックされ、解除するまでアプリが使えない。
#       キオスク機はパスコード無し（またはガイドアクセス）にしておくこと。
cmd_reboot() {
  detect_device
  echo "▶ iPhone本体を再起動（--wait-for-device で復帰待ち）"
  xcrun devicectl device reboot --device "$CORE_ID" --wait-for-device --timeout 180 || true
  echo "▶ 復帰後、アプリを起動"
  # 再起動直後はサービスが立ち上がるまで数回リトライ
  for i in 1 2 3 4 5 6; do
    if xcrun devicectl device process launch --terminate-existing --device "$CORE_ID" "$BUNDLE_ID" 2>/dev/null; then
      echo "アプリ起動OK"; break
    fi
    echo "  起動待ち… ($i)"; sleep 10
  done
}

# プロファイル更新を伴う再ビルド（週次の自動更新用）。
# -allowProvisioningUpdates で失効前のプロファイルを焼き直し、入れ直して起動する。
# Apple IDアカウントに接続するため、GUIログイン中のセッションで実行すること。
cmd_refresh() {
  detect_device
  echo "▶ プロファイル更新つき再ビルド (team=$DEVELOPMENT_TEAM)"
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
  echo "=== 接続デバイス ==="; xcrun devicectl list devices 2>/dev/null | grep -i connected || echo "なし"
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
