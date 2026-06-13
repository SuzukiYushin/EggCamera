# EggCamera Slack Bot（遠隔 状況確認・再起動）

Slackから `/egg <コマンド>` でキオスクの状況確認・各種再起動ができる。
**Socket Mode** なので Mac mini から Slack へ外向き接続するだけ。会場のNAT/ファイアウォール内でも
公開ポートやトンネルは不要。

## コマンド（`/egg <sub>`）

| コマンド | 動作 |
|---|---|
| `/egg status` | Node/iPhone/ディスク/失敗画像/メモリ/死活ビート/常駐サービスを一覧 |
| `/egg restart node` | Nodeサーバ再起動（:3000復旧確認つき） |
| `/egg restart mac` | EggCameraMac再起動（:8081/8082確認） |
| `/egg restart iphone` | iPhoneアプリ再起動（ビルドなし・速い、:8080確認） |
| `/egg refresh iphone` | iPhoneアプリ再ビルド＋入れ直し（プロファイル更新） |
| `/egg logs` | 直近の実エラーログ |
| `/egg failed` | 失敗画像の一覧 |
| `/egg help` | コマンド一覧 |

再起動系は実行前後に自動で DEPLOY-MARKER をテストログへ投稿し、復旧（:8080=200等）も確認する。

## 本体リブートは専用コマンド `/egg-reboot`（誤操作防止）

Mac mini / iPhone「本体」の再起動は、通常の `/egg` とは**別のスラッシュコマンド**に分離し、
さらに末尾 `confirm` を必須にしている（二重の誤操作防止）。

| コマンド | 動作 |
|---|---|
| `/egg-reboot mac confirm` | **Mac mini本体**を再起動（全サービス停止→autorestart/自動ログイン/launchdで自動復旧） |
| `/egg-reboot iphone confirm` | **iPhone本体**を再起動→アプリ起動（パスコード有りだと要手動解除） |
| `/egg-reboot help` | 説明 |

- `confirm` を付けないと実行されず確認文を返す。通常の不調は `/egg restart …` で対処すること。
- **Mac mini本体の再起動には sudoers 設定が一度だけ必要**（NOPASSWD）:
  ```
  echo "eggcamera ALL=(root) NOPASSWD: /sbin/shutdown, /sbin/reboot" | sudo tee /etc/sudoers.d/eggcamera-reboot
  sudo chmod 440 /etc/sudoers.d/eggcamera-reboot
  ```
  未設定だと `/egg-reboot mac confirm` は権限エラーを返す（壊れはしない）。

## iPhone本体再起動の注意

`restart iphone`（アプリ再起動）でほぼ解決する。本体再起動は最終手段:
- iOSは再起動後にアプリを自動起動しない → スクリプトがdevicectlで起動し直す（実装済み）
- **iPhoneにパスコードがあると、再起動後ロックされ、解除するまでアプリが使えない**。
  キオスク機は**パスコード無し**（または設定→アクセシビリティのガイドアクセス）にしておくこと。
- 約1〜2分の停止。USB接続が前提。


## 再起動後の自己診断＆操作ロック

`/egg restart …` および `/egg-reboot … confirm` を実行すると、自動で:
1. キオスクUIを**ロック**（ユーザー操作を受け付けない／「メンテナンス中」表示）
2. **1周セルフテスト**（撮影→合成→アップロード→DL確認）を実行
3. 結果を**Slackに通知**（✅/❌と各段階）
4. スタッフが **`/egg ok`** を送ると**ロック解除＝通常運用へ復帰**

Mac mini本体の再起動のようにBot自身も落ちる場合は、node起動時にフラグを見て
自動でセルフテストを実行する（保険）。ロックは `/egg ok` まで継続。

## Slackアプリ作成（一度だけ）

1. https://api.slack.com/apps → **Create New App** → From scratch → ワークスペース選択
2. **Socket Mode** を有効化 → App-Level Token を生成（スコープ `connections:write`）→ `xapp-...` を控える
3. **OAuth & Permissions** → Bot Token Scopes に `commands` と `chat:write` を追加 → ワークスペースにインストール → Bot Token `xoxb-...` を控える
4. **Slash Commands** → Create New Command:
   - Command: `/egg`　Description: `EggCamera 運用`　Usage hint: `status | restart node | ...`
   - （Socket Mode なので Request URL は不要）
   - 同様に **`/egg-reboot`** も追加（危険系・本体リブート専用）
5. **Event Subscriptions**（@メンションも使うなら）→ Subscribe to bot events: `app_mention`
6. Botを通知チャンネルに招待: `/invite @アプリ名`

## Mac mini 側の設定

```bash
cat > ~/EggCamera/.env.slackbot <<EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# 任意: 操作できるSlackユーザーIDを限定（カンマ区切り）。未指定なら全員可
# SLACK_ALLOWED_USERS=U01ABCDEF
EOF
chmod 600 ~/EggCamera/.env.slackbot

# 常駐起動（落ちても自動復帰）
launchctl bootstrap gui/$(id -u) ~/EggCamera/EggCameraBot/launchd/com.eggcamera.bot.plist
```

接続できると `~/Library/Logs/eggcamera-bot.out` に `Socket Mode connected` と出る。
Slackで `/egg status` を試す。

## ローカル動作確認（Slack不要）

```bash
cd ~/EggCamera/EggCameraBot
node bot.js test status
node bot.js test logs
```

## セキュリティ

- Slackワークスペースのメンバーであることが認可境界。さらに絞るなら `SLACK_ALLOWED_USERS`。
- 破壊的なMac mini自体の再起動(`sudo reboot`)は含めていない（sudo要・誤操作リスク）。
  必要なら別途 sudoers 設定の上でコマンド追加可能。
