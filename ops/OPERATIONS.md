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
| `com.eggcamera.soak-watch` | テスト番犬（モデル非依存・Slack検知） | 10分ごと | ~/Library/Logs/eggcamera-soak-watch.log |
| `com.eggcamera.bot` | Slack遠隔操作Bot（/egg status・restart…） | 常駐(KeepAlive) | ~/Library/Logs/eggcamera-bot.{out,err} |

plist の実体はリポジトリ `ops/launchd/` に保管。再構築は:
```bash
cp ops/launchd/com.eggcamera.*.plist ~/Library/LaunchAgents/
for j in node mac backup iphone-refresh; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eggcamera.$j.plist; done
```
操作: `launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`（再起動） / `launchctl bootout gui/$(id -u)/com.eggcamera.node`（停止）

## 本番運用と監視の関係（重要）

- **本番運用（実顧客が使う）では Chrome拡張も Claude も不要。** 監視は完全に自走する:
  サーバ側 Slack 通知（失敗画像/課金/ディスク/未捕捉エラー/起動時不備）＋ 死活監視Worker ＋ launchd常駐監視。
- **Chrome拡張 ＋ Claude監視ループ は本番前のストレステスト専用**（無人で長時間回して壊れないか検証する道具）。本番では動かさない。
- **テスト番犬（soak-watch）** はモデル非依存。テスト中にClaude監視が落ちても、想定外/コスト警告/サーバ無応答/停滞/DL失敗の「増加」とスナップショット途絶を Slack で検知し続ける。

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

## Mac mini の電源・ログイン設定（設定済み 2026-06-13）

無人復旧のための設定。停電→復電で「自動起動→自動ログイン→launchdが全サービス起動」まで全自動。

| 設定 | 値 | 意味 |
|---|---|---|
| 自動ログイン | `eggcamera` | 再起動後パスワード無しでデスクトップ到達（launchdのGUIセッション維持） |
| `pmset -c sleep` | 0 | 本体スリープしない |
| `pmset -c disksleep` | 0 | ディスクスリープしない（アップロード中の引っかかり予防） |
| `pmset -c autorestart` | 1 | 電源障害後に自動起動 |
| `pmset -c womp` | 1 | Wake on LAN |
| displaysleep | 10分 | 画面だけ消えて本体は稼働（省電力・正常） |

確認: `pmset -g` / `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`
再設定: `sudo pmset -c sleep 0 disksleep 0 autorestart 1`、自動ログインは GUI「ユーザとグループ」。
注: 自動ログインには FileVault が OFF である必要がある。


## リモートデスクトップ（最終手段）

Slack Bot で対処できない事態のための SSH / 画面共有。Cloudflare Tunnel の
**ドメイン不要・WARPプライベートネットワーク**方式（Mac miniに固定IP 10.99.99.1）。
手順は `ops/remote-desktop.md`。WARPをONにして `ssh eggcamera@10.99.99.1` /
`open vnc://10.99.99.1`。Cloudflareアカウント移行時はトンネルを作り直すだけ。

## ハードウェア（ソフトで対処不可・要手配）

- **UPS（無停電電源）**: 会場の電源ブレ・瞬断対策。Mac mini と iPhone充電を保護。電源復帰時は autorestart + 自動ログイン + launchd で自動復旧するが、UPSがあれば瞬断で落ちないので無停止に近づく。**唯一の未対応項目。**

## 起動セルフチェック

サーバ起動時に R2 必須鍵の有無を検証し、不備なら Slack 通知＋ログ。誤デプロイを最初の撮影前に検知。
