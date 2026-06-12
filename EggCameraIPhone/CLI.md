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
| 署名チーム | `4U78CNU7WN`（プロファイルのチーム。証明書は siggaze.0000@gmail.com を使用） |
| プロファイル | iOS Team Provisioning Profile: com.siggaze.eggcamera（Xcode生成・管理） |

`run`（ビルド込み）も `restart`（起動だけ）も **CLIのみで完結**（実機検証済み）。
`restart` / `launch` は devicectl のみで動くため署名・ビルドも不要。

## 仕組みのポイント

- `-allowProvisioningUpdates` は**付けない**。CLIからはXcodeのApple IDアカウントが
  見えず `No Accounts` で失敗するため。代わりに **Xcodeが生成済みの管理プロファイルを
  そのまま使う**（自動署名 + 正しいチームID `4U78CNU7WN`）。
- このため `run`/`build` は「有効な管理プロファイルが存在する間」だけCLIで通る。

## プロファイル失効・端末追加時（Personal Team は約7日で失効）

ビルドが `No profiles ...` で失敗したら、一度だけ **Xcodeでプロファイルを更新**する:

1. Xcode で `EggCameraIPhone.xcodeproj` を開く（または `xcodegen generate` 後に開く）
2. ターゲット → Signing & Capabilities でチームが選択され、エラーが消えるのを待つ
   （Xcodeが自動でプロファイルを再生成。Apple IDサインイン済みのGUIならワンクリック）
3. 以後また `./iphone.sh run` がCLIで通る

> 普段使い（アプリ再起動・コード変更の反映）はCLIで完結。Xcodeを開くのは
> プロファイル失効時の数日〜1週間に一度だけ。

## 従来手段（Makefile / ios-deploy）

`./iphone.sh` と等価のことが `make` でもできる（インストールは ios-deploy 経由）:

```bash
make restart                 # = ./iphone.sh restart
make install                 # ビルド → ios-deploy でインストール
make devices                 # 接続確認
```
