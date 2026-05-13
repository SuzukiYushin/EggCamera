SCHEME    := EggCameraIPhone
PROJECT   := EggCameraIPhone.xcodeproj
BUILD_DIR := .build
APP       := $(BUILD_DIR)/Build/Products/Debug-iphoneos/$(SCHEME).app

# Apple Developer Team ID を引数で渡す
#   make install DEVELOPMENT_TEAM=XXXXXXXXXX
#
# Team ID の確認方法:
#   Xcode → Settings → Accounts → 自分のアカウントを選択 → Team ID 列
DEVELOPMENT_TEAM ?= 4U78CNU7WN
DEVICE_ID ?= 00008130-001A604202A0001C

# ─────────────────────────────────────────────
.PHONY: generate build install deploy clean setup

## ① XcodeGen で .xcodeproj を生成
generate:
	xcodegen generate

## ② ビルド（generate も自動実行）
build: generate
ifndef DEVELOPMENT_TEAM
	$(error DEVELOPMENT_TEAM が未設定です。 make build DEVELOPMENT_TEAM=XXXXXXXXXX DEVICE_ID=YYYYYY)
endif
ifndef DEVICE_ID
	$(error DEVICE_ID が未設定です。make devices で確認してから指定してください)
endif
	xcodebuild \
		-project $(PROJECT) \
		-scheme $(SCHEME) \
		-configuration Debug \
		-destination 'platform=iOS,id=$(DEVICE_ID)' \
		-derivedDataPath $(BUILD_DIR) \
		DEVELOPMENT_TEAM=$(DEVELOPMENT_TEAM) \
		CODE_SIGN_STYLE=Automatic \
		-allowProvisioningUpdates \
		build

## ③ ビルド → iPhone にインストール（USB接続必須）
install: build
	ios-deploy --bundle "$(APP)" --no-wifi

## ③' ビルド済みの .app だけ再インストール
deploy:
	ios-deploy --bundle "$(APP)" --no-wifi

## 接続中の iPhone を確認
devices:
	ios-deploy --detect

## 生成物を全て削除
clean:
	rm -rf $(BUILD_DIR) $(PROJECT) Info.plist

## 依存ツールを一括インストール
setup:
	brew install xcodegen ios-deploy
