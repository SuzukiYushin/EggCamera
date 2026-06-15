# モジュール化・障害分離リファクタリング計画

作業ブランチ: `refactor/modular-resilience`（git worktree `/Users/eggcamera/EggCamera-refactor`）
本番 `/Users/eggcamera/EggCamera`（feature/backend-integration）は走行中。**ここでは一切触らない。**
適用: 明日の長期運用停止枠で本番へマージ・デプロイ。

## 目的
「一箇所のバグでシステム全停止」を防ぐ。機能を分離し、ある機能が落ちても**撮影クリティカルパスは動き続ける**。

## 原則（障害分離の3本柱）
1. **プロセス分離** — 非クリティカル機能を別プロセスへ。クラッシュ/暴走/リークが撮影を巻き込まない。
2. **エラーバウンダリ** — 全ルート/全バックグラウンドジョブを try/catch＋タイムアウトで包み、1つの例外がプロセスを倒さない。
3. **差し替え可能アダプタ** — カメラ・ストレージ・通知を抽象境界の裏へ。実装（iPhoneアプリ↔一眼、R2↔他）を交換可能に。

## 機能の階層分け
- **Tier1 クリティカル（絶対止めない）**: セッション / 撮影トリガ / 合成受信 / QR生成 / deferred-upload退避
- **Tier2 重要だが縮退可**: R2アップロード（deferredで縮退済）/ ライブプレビュー（イラスト代替済）
- **Tier3 運用・非ユーザ向け（落ちても撮影継続）**: 管理画面/フレーム管理/設定/ログ/diagnose/restart/chaos/失敗画像/notify/metrics/maintenance/selftest/backup

## 目標アーキテクチャ
```
egg-core   (:3000)  Tier1+Tier2。最小依存・最強堅牢。これだけで撮影は完結。
egg-admin  (:3001)  Tier3。管理/運用API+静的admin。別プロセス・別launchd。
shared/             config・logger・slack・データアクセス（フレーム/設定/mode/failed）
adapters/
  camera/           trigger()->{rawPath}  （現: iPhoneアプリ経由 / 将来: gphoto2一眼）
  storage/          R2 / ローカル
  notify/           Slack（fire-and-forget・本流に絶対throwしない）
```
- core と admin は **同じ data/ をファイル経由で共有**（mode.json・settings・frames・failed・logsファイル）。
- in-memory状態の結合は内部APIで解す（下記）。

## 結合点と解し方
| 状態 | 現状 | 分離後 |
|---|---|---|
| mode（メンテ） | data/mode.json | そのまま共有OK |
| frames/settings | ファイル | そのまま共有OK |
| logs | **in-memoryリングバッファ** | **ファイル追記**に変更 → adminはファイルを読む（既に eggcamera-node.out あり、構造化ログを data/logs/app.jsonl へ） |
| chaos | **in-memory（coreの撮影が consume）** | core側API `POST /internal/chaos`（adminから叩く）。chaosはcore内に残す |
| sessions | in-memory（core） | adminは触らない |
| diagnose/restart/selftest | coreのlogger/ops参照 | adminが ops を直接実行（ファイルログ参照）。restartは元々launchctl/ssh |

## フェーズ
- **Phase 1 — エラーバウンダリ＋タイムアウト（低リスク・最優先・明日適用）**
  - `safeHandler` で全Expressルートを包む（throw→500+log、プロセス継続）。
  - 全バックグラウンド（metrics interval / deferredUpload / backup / selftest / slack / maintenance timer）を try/catch 化、外部呼び出し（R2/Mac/iPhone/Slack）に**タイムアウト必須**。
  - Slackは絶対に本流へ例外を投げない（既throttle＋await無し送信）。
  - uncaughtException/unhandledRejection: ログ＋Slack＋**graceful restart**（launchd任せ、ただしクリティアルパス中はベストエフォート継続）。
- **Phase 2 — admin/ops を別プロセス分離（:3001・明日 or 次枠）**
  - logsをファイルベース化（リングバッファ→ data/logs/app.jsonl）。adminはファイル読み。
  - chaosをcoreの内部APIへ。adminは内部API経由でarm。
  - admin用 launchd plist（KeepAlive）追加。トンネルで :3001 を別ルート化。
- **Phase 3 — カメラアダプタの正式化**
  - `adapters/camera/iphone.js`（現 capture.js を移植）＋ interface `trigger()->rawPath`。
  - 将来 `adapters/camera/dslr.js`（gphoto2）を差すだけでiPhoneアプリ撤去可能に。
- **Phase 4（将来）** — アップロードのキュー/ワーカー化、ヘルス集約、サービスメッシュ化。

## 明日 本番に入れる範囲（提案）
- **Phase 1 全部**（堅牢化・低リスク・E2E検証容易）。
- 余裕あれば **Phase 2 のログのファイル化**まで（admin分離の前提）。admin別プロセス本体は検証後の次枠でも可。

## テスト計画（worktree内・本番に触れない）
- worktreeの core/admin を **別ポート（:3100/:3101）** で起動して検証（本番 :3000 と衝突させない）。
- 障害注入: adminプロセスを kill / 例外を強制 → **coreの撮影API（:3100）が無事**を確認（=分離の証明）。
- 各ルートに不正入力 → 500を返すがプロセス継続を確認。
- 外部依存ダウン（R2/Mac/iPhone擬似タイムアウト）→ 撮影パスがハングしない（タイムアウト効く）を確認。

## 適用手順（明日・本番停止枠）
1. soak停止 ＋ DEPLOY-MARKER。
2. `refactor/modular-resilience` を feature/backend-integration へマージ。
3. （Phase2採用時）admin用 launchd 追加・トンネルルート追加。
4. node/admin 再起動 → セルフテスト → soak再開。

## iPhoneアプリの位置づけ
- iOSの最適化スチルを使う限りアプリは必須（USBホストからの高品質スチル遠隔起動APIは無し）。
- ただし **カメラをアダプタ化**しておけば、将来 **テザリング一眼(gphoto2)** に差し替えてアプリ/プロビジョニングを撤去できる。今回はアダプタ境界だけ用意し、実体はiPhoneのまま。

---

## Phase 2 完了・デプロイ追記（admin別プロセス）

worktree で実装＋検証済み（:3100/:3101 で2プロセス起動→admin kill→core撮影パス無事を確認）。
本番適用時の追加手順（明日の停止枠）:

1. soak停止 ＋ DEPLOY-MARKER。
2. `EggCameraNode/.env` に **REBOOT_PASSWORD** を設定（未設定だと再起動API=503）。
3. `refactor/modular-resilience` を feature/backend-integration へマージ。
4. admin常駐を登録:
   `cp ops/launchd/com.eggcamera.admin.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eggcamera.admin.plist`
5. node(core) 再起動（kickstart）→ adminCore反映・/admin静的配信を停止。
6. **管理画面URLが :3000/admin → :3001/admin に変わる**。Cloudflare Tunnel に :3001 のルートを追加し、`http://10.99.99.1:3001/admin?token=…` でアクセス。
7. 検証: 撮影(:3000)動作、:3001/admin 表示、admin kill→core無事、`/egg status`（bot=:3001参照）、check-soak（:3001）。
8. soak再開。

注意:
- ops消費側は env で admin先を指定可: bot=`EGG_ADMIN_URL`、check-soak/recover=`ADMIN_PORT`/`ADMIN_URL`（既定 :3001）。
- 長期運用テスト拡張(content.js)は変更不要（chaos/metrics は core :3000 のまま）。
