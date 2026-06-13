# EggCamera 運用・信頼性ガイド（Mac mini キオスク）

無人運用のために仕込んだ自動化・監視・復旧の一覧と手順。

## 常駐サービス（launchd・落ちたら自動復帰／電源投入で自動起動）

| Label | 役割 | 種類 | ログ |
|---|---|---|---|
| `com.eggcamera.node` | Node サーバ(:3000) | KeepAlive + RunAtLoad | ~/Library/Logs/eggcamera-node.{out,err} |
| `com.eggcamera.mac` | EggCameraMac(:8081/8082) | KeepAlive + RunAtLoad | ~/Library/Logs/eggcamera-mac.{out,err} |
| `com.eggcamera.backup` | 設定・フレーム日次バックアップ | 毎日3:30 | ~/Library/Logs/eggcamera-backup.log |
| `com.eggcamera.iphone-refresh` | iPhone署名の週次更新＋起動確認 | 毎日4:30 | ~/Library/Logs/eggcamera-iphone-refresh.log |
| `com.eggcamera.heartbeat` | 死活監視ビート送信（要 .env.watchdog） | 5分ごと | — |

plist の実体はリポジトリ `ops/launchd/` に保管。再構築は:
```bash
cp ops/launchd/com.eggcamera.*.plist ~/Library/LaunchAgents/
for j in node mac backup iphone-refresh; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eggcamera.$j.plist; done
```
操作: `launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`（再起動） / `launchctl bootout gui/$(id -u)/com.eggcamera.node`（停止）

## 監視・通知

- **長期運用テスト**（別Chrome拡張）＋ 30分ごとの監視セッション。テスト影響操作の前後は必ず DEPLOY-MARKER（[[deploy-marker-protocol]] 参照）。
- **Slack 通知**: プロビジョニング失効/更新失敗、R2課金(8GB)、失敗画像(人力対応)、ディスク逼迫(5GB)、未捕捉エラー、起動時設定不備。手動報告は `POST /api/admin/notify {text,kind}`。
- **死活監視（デッドマンスイッチ）**: `EggCameraWatchdog/`（Cloudflare Worker）。Mac mini が15分ビート途絶で Slack 通知。Mac mini が丸ごと落ちても検知できる唯一の経路。デプロイ手順は EggCameraWatchdog/README.md。

## バックアップ / リストア

- 日次: `data/backups/full-<日時>.tgz`（機密込み・直近14世帯）＋ R2 `backups/config-<日時>.tgz`（frames+settings・オフサイト）。
- リストア（ローカル）: `tar -xzf data/backups/full-XXXX.tgz -C .`（リポジトリ直下で展開）。
- R2からフレーム復旧: R2の `backups/config-*.tgz` を取得して `data/assets/frames` へ展開。
- **.env の機密**（R2鍵・Slack・Watchdog）はローカル保管のみ。SSD故障に備え一度オフサイト（パスワードマネージャ等）へ控えること。

## リリースとロールバック

- 安定版にはタグを付ける: `git tag -a stable-YYYYMMDD -m "本番稼働" && git push origin --tags`
- 戻したいとき: `git checkout <tag>` → UIは `cd EggCameraUserUI && npm run build`、Pagesは `EggCameraPages/deploy.sh`、サーバは `launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`。
- ダウンロードページのデプロイ: `EggCameraPages/deploy.sh`（wrangler）。

## 管理画面の認証（任意）

`EggCameraNode/.env` に `ADMIN_TOKEN=<長い文字列>` を設定すると `/api/admin/*` に認証が要る。
管理画面は一度 `http://<mac>:3000/admin?token=<同じ値>` で開けば localStorage に保存され以降自動付与。
未設定なら従来どおり認証なし。会場の共有wifiでは設定推奨。

## ハードウェア（ソフトで対処不可・要手配）

- **UPS（無停電電源）**: 会場の電源ブレ・瞬断対策。Mac mini と iPhone充電を保護。電源復帰時は launchd の RunAtLoad で自動復旧するが、UPSがあれば瞬断で落ちないので無停止に近づく。
- Mac mini は「自動ログイン」「スリープしない」設定にしておくこと（launchd の GUI セッション維持に必要）。

## 起動セルフチェック

サーバ起動時に R2 必須鍵の有無を検証し、不備なら Slack 通知＋ログ。誤デプロイを最初の撮影前に検知。
