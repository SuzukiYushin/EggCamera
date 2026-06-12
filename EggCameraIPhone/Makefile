SCHEME    := EggCameraIPhone
PROJECT   := EggCameraIPhone.xcodeproj
BUILD_DIR := .build
APP       := $(BUILD_DIR)/Build/Products/Debug-iphoneos/$(SCHEME).app

# 簡単な再起動/インストールは ./iphone.sh を使う（デバイス自動検出 + devicectl）。
# この Makefile は ios-deploy ベースの従来手段。
#
# プロファイル「iOS Team Provisioning Profile: com.siggaze.eggcamera」のチーム
DEVELOPMENT_TEAM ?= 4U78CNU7WN
# YUSHINのiPhone (iPhone 17) の UDID。`make devices` で確認
DEVICE_ID ?= 00008150-00184D192299401C
# devicectl 用の CoreDevice 識別子（launch/restart）
DEVICE_CORE_ID ?= EE28FFF6-9D8C-5321-A6F5-CDF5467D3B02
BUNDLE_ID ?= com.siggaze.eggcamera

# ─────────────────────────────────────────────
.PHONY: generate build install deploy launch restart clean setup

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
		build

## ③ ビルド → iPhone にインストール（USB接続必須）
install: build
	ios-deploy --bundle "$(APP)" --no-wifi

## ③' ビルド済みの .app だけ再インストール
deploy:
	ios-deploy --bundle "$(APP)" --no-wifi

## アプリを起動（既存プロセスは終了して入れ替え）— ビルド不要
launch restart:
	xcrun devicectl device process launch --terminate-existing --device $(DEVICE_CORE_ID) $(BUNDLE_ID)

## 接続中の iPhone を確認
devices:
	ios-deploy --detect

## 生成物を全て削除
clean:
	rm -rf $(BUILD_DIR) $(PROJECT) Info.plist

## 依存ツールを一括インストール
setup:
	brew install xcodegen ios-deploy
