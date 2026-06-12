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
# devicectl 用の識別子（install/launch）と xcodebuild 用の UDID（build）を取る
detect_device() {
  CORE_ID="${DEVICE_CORE_ID:-$(xcrun devicectl list devices 2>/dev/null \
    | awk -F'  +' '/connected/ {print $3; exit}')}"
  BUILD_UDID="${DEVICE_UDID:-$(xcrun xctrace list devices 2>/dev/null \
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
  echo "▶ インストール → $CORE_ID"
  xcrun devicectl device install app --device "$CORE_ID" "$APP"
}

cmd_launch() {
  detect_device
  echo "▶ 起動（既存プロセスは終了して入れ替え）"
  xcrun devicectl device process launch --terminate-existing --device "$CORE_ID" "$BUNDLE_ID"
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
  restart) cmd_launch ;;                       # ビルドせず再起動だけ
  run)     cmd_build && cmd_install && cmd_launch ;;
  status)  cmd_status ;;
  *) echo "usage: ./iphone.sh {run|build|install|launch|restart|status}" >&2; exit 1 ;;
esac
