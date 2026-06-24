#!/bin/bash
# resign-all.sh — Apple ID 再追加後に「本番iPhone署名 + WDA署名」を一括で焼き直す復旧ワンショット。
#
# 背景(2026-06-24): XcodeのApple IDアカウントが消失し、無料署名(Personal Team)の
#   プロビジョニングプロファイルを更新できなくなった。WDAは既に失効(iPadテスト不可)、
#   iPhone本番カメラ署名も 6/25 20:47 JST で失効予定。
#   無料署名は Xcode GUI 自動署名でしか更新できないため、まず人手で
#     Xcode → Settings → Accounts → Apple ID(siggaze.0000@gmail.com) を再追加(GUI+2FA)
#   が必須。それさえ済めば本スクリプトを SSH から1回流すだけで両方を再署名できる。
#
# 使い方(電話のSSHからでも可):
#   bash ~/EggCamera/ops/ipad/resign-all.sh            # iPhone本番 + WDA を再署名
#   bash ~/EggCamera/ops/ipad/resign-all.sh --test     # 上記後に ipad-test.js を1セッション実行
set -uo pipefail

IPAD_UDID="00008132-001E2934019A401C"
TEAM="4U78CNU7WN"
WDA="/Users/eggcamera/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"
WDA_DD="/Users/eggcamera/Library/Developer/Xcode/DerivedData/WebDriverAgent-dopylywrbtefnbfmomfcvcirfvqt"
IPHONE_DIR="/Users/eggcamera/EggCamera/EggCameraIPhone"

say(){ echo "▶ $*"; }

# ── 0) 前提チェック: XcodeにApple IDアカウント(登録チーム)があるか ──
# ※ Xcode 26系はアカウントを IDEAuthenticationData ファイルでは持たない。
#    登録チーム(IDEProvisioningTeamByIdentifier)の有無で判定するのが確実。
if ! defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -q "teamID"; then
  echo "✗ XcodeにApple IDアカウント(登録チーム)が見当たりません。"
  echo "  先に Mac の Xcode → Settings → Accounts で siggaze.0000@gmail.com を追加してください(GUI+2FA)。"
  echo "  追加が済んだら本スクリプトを再実行。"
  exit 2
fi

prof_exp(){ # $1=.app  → プロファイル名と失効日を表示
  security cms -D -i "$1/embedded.mobileprovision" 2>/dev/null | python3 -c "
import sys,plistlib,datetime
try:
 d=plistlib.loads(sys.stdin.buffer.read()); exp=d.get('ExpirationDate')
 now=datetime.datetime.now(datetime.timezone.utc)
 rem=(exp.replace(tzinfo=datetime.timezone.utc)-now).total_seconds() if exp else 0
 print('   ', d.get('Name'),'| exp',exp,'|', 'EXPIRED' if rem<0 else f'残り{rem/3600:.1f}h')
except Exception as e: print('   (プロファイル読取不可)',e)
"
}

# ── 1) 本番 iPhone 署名の焼き直し(週次refreshと同じ。-allowProvisioningUpdates build + install) ──
say "iPhone本番カメラ署名を更新 (iphone.sh refresh)"
( cd "$IPHONE_DIR" && DEVELOPMENT_TEAM="$TEAM" ./iphone.sh refresh ); IPH_RC=$?
echo "  iphone refresh rc=$IPH_RC"

# ── 2) WDA(WebDriverAgentRunner) 署名の焼き直し ──
say "WDAを再ビルド・再署名 (xcodebuild build-for-testing -allowProvisioningUpdates)"
xcrun xcodebuild build-for-testing \
  -project "$WDA/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$IPAD_UDID" \
  -derivedDataPath "$WDA_DD" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic 2>&1 | tail -6
WDA_RC=${PIPESTATUS[0]}
echo "  wda build rc=$WDA_RC"

# ── 3) 結果サマリ(新しい失効日) ──
echo "──────── 再署名後の失効日 ────────"
for a in \
  "$IPHONE_DIR/.build/Build/Products/Debug-iphoneos/EggCameraIPhone.app" \
  "$WDA_DD/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app"; do
  [ -d "$a" ] && { echo "$a"; prof_exp "$a"; }
done

# ── 4) 任意: iPadテスト1セッション ──
if [ "${1:-}" = "--test" ] && [ "$WDA_RC" = 0 ]; then
  say "ipad-test.js を1セッション実行"
  node /Users/eggcamera/EggCamera/EggCameraNode/tools/ipad-test.js
fi

[ "$IPH_RC" = 0 ] && [ "$WDA_RC" = 0 ] && { echo "✅ 両方の再署名に成功"; exit 0; } || { echo "⚠ 一部失敗(iphone=$IPH_RC wda=$WDA_RC)"; exit 1; }
