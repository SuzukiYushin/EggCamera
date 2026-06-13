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

## Slackアプリ作成（一度だけ）

1. https://api.slack.com/apps → **Create New App** → From scratch → ワークスペース選択
2. **Socket Mode** を有効化 → App-Level Token を生成（スコープ `connections:write`）→ `xapp-...` を控える
3. **OAuth & Permissions** → Bot Token Scopes に `commands` と `chat:write` を追加 → ワークスペースにインストール → Bot Token `xoxb-...` を控える
4. **Slash Commands** → Create New Command:
   - Command: `/egg`　Description: `EggCamera 運用`　Usage hint: `status | restart node | ...`
   - （Socket Mode なので Request URL は不要）
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
