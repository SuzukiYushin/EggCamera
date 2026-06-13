# EggCamera Watchdog（死活監視 / デッドマンスイッチ）

Mac mini が5分ごとに Cloudflare Worker へビートを送る。Worker の Cron Trigger が
Cloudflare 側で独立に動き、**15分ビートが途絶えたら Slack に通知**する。
Mac mini が丸ごと落ちても（停電・回線断・カーネルパニック）Worker は生きているので
「全部死んだ」を確実に検知できる。

## デプロイ（一度だけ・Workers権限のあるトークンか `wrangler login` が必要）

> 注: リポジトリ保存済みの Pages 用トークンでは Workers をデプロイできない。
> `wrangler login`（ブラウザ認証）か、Workers Scripts/KV 編集権限付きトークンを使う。

```bash
cd ~/EggCamera/EggCameraWatchdog

# 1) KV 名前空間を作成し、出力された id を wrangler.toml の REPLACE_WITH_KV_ID に貼る
npx wrangler kv namespace create WATCHDOG

# 2) シークレット2つを登録
npx wrangler secret put BEAT_SECRET        # 任意の長い文字列
npx wrangler secret put SLACK_WEBHOOK_URL  # 既存の Slack Webhook URL

# 3) デプロイ（Cron Trigger も同時に有効化）
npx wrangler deploy
# → https://eggcamera-watchdog.<subdomain>.workers.dev が払い出される
```

## Mac mini 側のビート送信を有効化

```bash
# Worker の URL と、上で設定した BEAT_SECRET を保存（git管理外）
cat > ~/EggCamera/.env.watchdog <<EOF
WATCHDOG_URL=https://eggcamera-watchdog.<subdomain>.workers.dev
BEAT_SECRET=<上と同じ値>
EOF

# launchd タイマー（5分ごと）を登録
launchctl bootstrap gui/$(id -u) ~/EggCamera/EggCameraWatchdog/launchd/com.eggcamera.heartbeat.plist
# 手動テスト
~/EggCamera/EggCameraWatchdog/heartbeat.sh && curl -s https://eggcamera-watchdog.<subdomain>.workers.dev | jq
```

## 動作確認

- `GET /`（Worker URL）で `{lastBeat, ageSec}` が返る。ageSec が5分以内なら正常。
- ビートを止めて15分待つと Slack に `:rotating_light:` 通知。再開すると `:white_check_mark:` 回復通知。

## 無料枠

Workers（10万req/日）・Cron Triggers・KV（無料枠）すべて無料枠内。5分間隔のビート＋Cronは
1日あたり数百リクエストで余裕。
