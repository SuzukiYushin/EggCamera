# iPhone カメラアプリ — Xcode CLI 操作

接続中のデバイスを自動検出する `./iphone.sh` を使う。

```bash
cd ~/EggCamera/EggCameraIPhone

./iphone.sh restart   # 起動中アプリを再起動（ビルド不要・最速）★よく使う
./iphone.sh run       # ビルド → インストール → 起動（コード変更後）
./iphone.sh build     # ビルドのみ
./iphone.sh install   # ビルド済み .app を再インストール
./iphone.sh launch    # 起動するだけ
./iphone.sh status    # 接続デバイス・各種ID・チームの確認
```

## 動作環境（このMac mini）

| 項目 | 値 |
|---|---|
| デバイス | YUSHINのiPhone (iPhone 17) |
| ビルド用 UDID | 自動検出（`xctrace list devices`） |
| devicectl 識別子 | 自動検出（`devicectl list devices`） |
| Bundle ID | `com.siggaze.eggcamera` |
| 署名チーム | `6FKKW68VQ4`（Apple Development: siggaze.0000@gmail.com） |

`restart` / `launch` は devicectl のみで動くため**署名・ビルド不要**。
普段の「アプリを入れ直さず再起動したい」はこれで完結する。

## 新規ビルド（run / build）の前提 — 一度だけ手動設定が必要

このMac miniには証明書はあるが **Xcode にApple IDアカウントが未登録**のため、
`xcodebuild` の自動署名がプロビジョニングプロファイルを作れず `run`/`build` は失敗する
（`No Accounts` / `No profiles for com.siggaze.eggcamera`）。

一度だけ以下を実施すれば、以後 `./iphone.sh run` がCLIだけで通る:

1. Xcode を起動 → **Settings → Accounts → +** → Apple ID `siggaze.0000@gmail.com` でサインイン
2. 同画面でチーム（Personal Team）が出ることを確認
3. 一度 `./iphone.sh run` を実行（初回は `-allowProvisioningUpdates` がプロファイルを自動生成）

> Personal Team のプロファイルは7日で失効し、デバイス紐付けも端末ごと。
> 端末を変えた・1週間以上空いた場合は `run` で作り直す（アカウント登録済みなら自動）。

## 従来手段（Makefile / ios-deploy）

`./iphone.sh` と等価のことが `make` でもできる（インストールは ios-deploy 経由）:

```bash
make restart                 # = ./iphone.sh restart
make install                 # ビルド → ios-deploy でインストール
make devices                 # 接続確認
```
