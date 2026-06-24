# サーバ側合成 + 永続アップロード 設計プラン

最終更新: 2026-06-24 / 対象ブランチ: feature/backend-integration

## 0. 背景と狙い

現状、最終完成画像は **iPad Safari のブラウザ canvas で合成**され、その JPEG を `POST /api/sessions/:id/composite` でサーバに送っている（[FinalPreview.tsx](EggCameraUserUI/src/components/screens/FinalPreview.tsx) → [sessions.js](EggCameraNode/src/routes/sessions.js)）。

これに起因して 2 つの問題がある:

1. **合成取りこぼし（無音失敗）**: `canvas.toBlob` が iPad Safari の高解像度 canvas（48MP 写真→約 4032×6048 ≒ 24Mpx, RGBA 約 97MB）のメモリ圧で `null` を返すと、`if (blob) onNext(blob)` で握りつぶされ、アップロードも QR 遷移も起きずに固まる（2026-06-24 19:00 C1 / 20:00 C3 で実証。暫定対処としてリトライ+可視化を投入済み = `handleSave`）。
2. **失敗ハンドリングが不可能**: ブラウザ合成では、客が帰った後（ブラウザ消滅後）に「再合成」「再アップロード」「再起動後の再開」ができない。

### 方針（本プランの核心）
**サーバを唯一のレンダラーにし、フロントはサーバが合成した完成画像のサムネを表示するだけにする。**

- 完成画像（原寸 48MP）はサーバの `sharp` で合成 → iOS の canvas/メモリ制限を一切受けない。
- プレビューは「本物の完成画像の縮小版」= 定義上 100% WYSIWYG。**二重レンダラーが無いのでピクセル一致作業が消滅**。
- 合成もアップロードもサーバ側 = 「成功するまで再試行」「再起動後に再開」が**原理的に可能になる**。これは下記の失敗ハンドリング仕様一式の前提。

---

## 1. 対象仕様（要件）

### アップロード失敗時
- 1.1 アップロード失敗（お詫び画面）の対象は**すべて管理画面の失敗ページに表示**。撮影日時・ダウンロードページ QR も一緒に表示。
- 1.2 アップロードステータスを**リアルタイム更新**。
- 1.3 ステータス=完了 → スタッフが QR を客に提示しダウンロード画面へ案内。
- 1.4 ステータス=アップロード中 → 客に一旦 QR を撮影してもらい、帰宅後に再接続。
- 1.5 **アップロードにタイムアウト無し**。完成画像はアップロード成功まで再試行し続ける。
- 1.6 **再起動後も**未完了の完成画像があればアップロードを再開。
- 1.7 完成画像の 24H 削除は、**サーバ到達（アップロード完了）時点から起算**し、**サーバとローカル両方から削除**。
- 1.8 アップロード完了日時を表示。
- 1.9 失敗画像は管理画面から**ダウンロード可能**。
- 1.10 最悪、客のメアドを聞いて**メール送付**も可能。

### 合成失敗時
- 1.11 失敗ページに表示。ステータス=**合成失敗**。
- 1.12 後ろで**再合成→アップロードまでを成功まで繰り返す**。
- 1.13 それ以外はアップロード失敗時と同じ仕様。

---

## 2. 現状資産の棚卸し（流用可否）

| 資産 | 場所 | 流用 |
|---|---|---|
| サーバ側合成（写真+フレーム, 原寸） | `composite.js:compositeForSession` | ◎ 土台に。**クロップ/文字未対応**→拡張要 |
| クライアント合成（クロップ+フレーム+文字） | `FinalPreview.tsx` の canvas 描画 | △ ロジックをサーバへ移植（パリティ不要） |
| 選択メタ（photoId/nickname/days）保存 | `sessions.js:/select` | ◎ ほぼ揃う。frameId/crop を追加 |
| クロップ設定 | `GET /api/settings`（admin） | ◎ サーバ側で取得可 |
| フレーム管理/抽選 | `frames` モジュール / クライアントが random | △ **抽選をサーバへ**移す or frameId をクライアントが送る |
| QR 生成（アップロード非依存・確定ファイル名から） | `composite.js:generateQRDataUrl` | ◎ アップ前でも QR を即発行可（仕様 1.4 に合致） |
| 後追いアップロード（バックオフ・FAILED_DIR・Slack） | `composite.js:deferredUploadToR2` | ◎ 概念流用。**ただし再起動非永続**→永続キュー化 |
| 失敗一覧/手動DL/再送 | `admin.js:/failed*` + `listFailedUploads/retryFailedUpload` | ◎ 拡張（撮影日時/QR/リアルタイム状態/メール） |
| R2 24H 削除（LastModified 基準） | `composite.js:cleanupOldR2Objects` | ◎ ローカル時刻基準削除を追加 |
| セッション（in-memory, TTL30分） | `sessions.js` | ✗ **揮発する**。完成画像ジョブは**ディスク永続**へ分離 |
| SSE | `/api/events`（settings-changed） | ◎ 失敗ページのリアルタイム更新に流用 |

### 現状の重要な穴（本プランで塞ぐ）
- **deferredUploadToR2 は in-memory ループ**。`DEFERRED_DIR` にファイルは残るが、再起動するとリトライループ自体が消える → 仕様 1.6 未達。
- **ローカル `COMPOSITED_DIR` は件数トリム**（時刻基準でない）→ 仕様 1.7（アップロード時点から 24H でローカルも削除）未達。
- **raw は完成前にトリムされ得る** → サーバ再合成（仕様 1.12）の入力が消える危険 → ジョブに **元写真を同梱**して自己完結化。

---

## 3. 新アーキテクチャ

### 3.1 永続ジョブモデル（再起動耐性の中核）
完成画像 1 枚 = 1 ジョブ。**ディスク上に自己完結**で持つ（in-memory セッションとは分離）。

```
data/jobs/<jobId>/
  job.json        # 状態とパラメータ（下記）
  source.heic     # 確定タップ時に選択 raw を複製（再合成の入力・raw トリムや再起動に耐える）
  composite.jpg   # 合成済み完成画像（worker が生成）
```

`job.json`:
```jsonc
{
  "jobId": "….",
  "sessionId": "….",
  "fileName": "familia_EggCamera_2026.06.24.20.07.40.jpg",
  "capturedAt": 1750000000000,      // 撮影日時（表示用・仕様1.1）
  "frameId": "frameB",
  "crop": { "zoom": 1, "offsetX": 0, "offsetY": 0 },
  "nickname": "…", "days": 270,
  "status": "composing|composite_failed|uploading|upload_failed|done",
  "attempts": 0, "lastError": null,
  "createdAt": …, "uploadedAt": null  // 完了日時（仕様1.8）・24H削除の起点（仕様1.7）
}
```

### 3.2 状態遷移
```
confirm → composing ─(失敗)→ composite_failed ─┐(無限リトライ・バックオフ)
              │(成功)                          │
              ▼                                ▼
          uploading ─(失敗)→ upload_failed ─(無限リトライ)→ uploading …
              │(成功)
              ▼
            done ──(uploadedAt + 24H)──▶ R2削除 + ローカル削除 + ジョブ破棄
```
- **タイムアウト無し**（仕様 1.5）。`composite_failed`/`upload_failed` は「直近の試行が失敗」を示すラベルで、worker は成功まで回し続ける。
- 一定時間（例 既存同様 1h）詰まったら**管理画面失敗ページに表出**＋Slack（throttle）。成功で自動的に一覧から消える。

### 3.3 Worker（単一の永続キュー処理）
- **起動時**: `data/jobs/` を走査し、`done` 以外の全ジョブをキューへ → **再開**（仕様 1.6 / 1.12）。
- **処理**: 各ジョブで「`composite.jpg` が無ければ source+params から合成」→「R2 アップロード」→「`uploadedAt` 記録し done」。各段は成功までバックオフ・リトライ。
- 既存 `deferredUploadToR2` のバックオフ/Slack/FAILED 表出ロジックを**ジョブ worker に統合**（FAILED_DIR の役割はジョブ状態へ吸収）。
- `sharp.concurrency(1)` 既定どおり逐次処理（RSS 肥大対策の既存方針を踏襲）。

### 3.4 サーバ合成エンジン（`compositeForSession` の拡張）
入力: source（raw/JPEG）, frameId, crop, nickname, days。出力: 原寸 JPEG q95 + サムネ。
1. **2:3 クロップ**（zoom/offsetX/offsetY）= sharp `extract`/`resize`（クライアント canvas の式 [FinalPreview.tsx:116-143](EggCameraUserUI/src/components/screens/FinalPreview.tsx#L116-L143) を移植）。
2. **フレーム重ね**（fill）= 既存 `compositeForSession` の `resize(fit:'fill')` + `composite([{blend:'over'}])`。
3. **文字**（nickname/days）= sharp に **SVG テキストレイヤー**を `composite`。フォント（見出しフォント / Futura）をサーバに同梱。位置・サイズ・縁取り・letterSpacing は [FinalPreview.tsx:148-186](EggCameraUserUI/src/components/screens/FinalPreview.tsx#L148-L186) の定数を移植し**デザイン通りに**描く（既存 canvas との厳密一致は不要）。
4. **サムネ生成**: 完成画像を長辺 ~1080 に縮小した JPEG（dataURL or `/api/sessions/:id/preview-image`）。

> 注意点: sharp の SVG テキストは librsvg/pango 依存でフォント実体が要る。letterSpacing/行高の見た目はブラウザと微差が出るので、**実機サムネで目視調整**する工程を 1 つ設ける。

### 3.5 API 変更（ユーザー UI ⇄ コア :3000）
| 新/変更 | エンドポイント | 役割 |
|---|---|---|
| 新 | `POST /api/sessions/:id/compose` | 選択写真+frame(server抽選)+crop+文字でサーバ合成。`{ thumbDataUrl, fileName, capturedAt }` を返す（プレビュー用） |
| 変更 | `POST /api/sessions/:id/confirm`（旧 `/composite` を置換） | 永続ジョブ作成（source 複製+params）→ upload worker 投入。`{ qrDataUrl, downloadUrl, status }` を即返す（QR はアップ非依存） |
| 廃止 | `POST /api/sessions/:id/composite`（raw body 受け） | クライアント合成廃止に伴い削除（移行完了後） |
| 既存 | `GET /api/sessions/:id` | status/result をクライアントが polling（uploading/done 反映） |

### 3.6 管理画面（:3001）失敗ページ拡張
- `GET /api/admin/jobs`（新, 旧 `/failed` を一般化）: 失敗/滞留中ジョブ一覧。各要素に **撮影日時 / fileName / 現在ステータス / QR(dataUrl) / DL URL / uploadedAt**。
- リアルタイム更新: **SSE `/api/events`** に `job-changed` を追加し、管理画面で購読（既存 settings-changed と同じ仕組み）。
- 操作: 手動再送（既存 retry）/ 手動DL（既存）/ 削除 / **メール送付**（新, 客アドレス入力→送信。SMTP or Cloudflare Email。PII 取り扱い注意・最終手段）。

### 3.7 保持/削除（仕様 1.7）
- R2: 既存 `cleanupOldR2Objects`（LastModified=アップロード時刻 基準 24H 削除）を踏襲。
- **ローカル**: `done` ジョブを `uploadedAt + 24H` で `composite.jpg`/ジョブディレクトリごと削除（時刻基準）。`COMPOSITED_DIR` の件数トリムは併用可だが、正本は**ジョブの uploadedAt**。

### 3.8 クライアント（ユーザー UI）変更
- `FinalPreview.tsx`: **canvas/toBlob/クロップ/文字描画を全廃**。マウント時に `POST /compose` → ローディング → 返ってきた**サムネ画像を表示**。`決定` → `POST /confirm` → QR 画面へ。
- `Uploading`/`QR` 画面: `confirm` 応答の QR を即表示。status=uploading でも QR 提示可（仕様 1.4）。done で完了日時表示（仕様 1.8）。
- 暫定リトライ #1（`handleSave` の toBlob リトライ）は移行完了後に**クライアント合成パスごと撤去**。
- `api.ts`: `compose()`/`confirm()` を追加、`uploadComposite()` を撤去。

---

## 4. 段階的ロールアウト

| Phase | 内容 | 成果物 / 検証 | 状態 |
|---|---|---|---|
| P1 | **サーバ合成エンジン**（crop+frame+文字+サムネ）。`compose` エンドポイント | 実機サムネで crop+frame が本番合成と一致・フォント解決を確認 | ✅ 完了（[src/compose.js](EggCameraNode/src/compose.js)・配置は後日5パターン作成） |
| P2 | **永続ジョブモデル + worker + 再起動再開 + 時刻基準削除**。`/compose`・`/confirm` 配線。既存 `/composite` は温存 | オフライン統合テスト17件 pass（compose→confirm→done / 失敗リトライ / composite欠落→再合成 / resumeAll再開 / 24H・TTL掃除） | ✅ 完了（[jobs.js](EggCameraNode/src/jobs.js)/[uploadWorker.js](EggCameraNode/src/uploadWorker.js)・**未デプロイ=server未再起動**） |
| P3 | クライアントを**サムネ表示フロー**へ切替。サーバ駆動フラグ `SERVER_COMPOSITE` で新旧切替（既定OFF=旧canvas・即ロールバック可） | 型チェック＋本番ビルド(一時outDir)成功。FinalPreview は温存し新規 FinalPreviewServer を追加 | ✅ 完了（dark=ライブ dist 未ビルド） |
| P4 | 管理画面**失敗ページ拡張**（撮影日時/QR/リアルタイム状態/手動DL）。※メール送付はアプリ実装せずスタッフ手作業 | listAdminJobs フィルタのオフラインテスト PASS。jobs一覧＋3秒ポーリング＋QR/DL を追加（adminAuth保護下） | ✅ 完了（dark=:3001再起動で /jobs 有効化） |
| P5 | デッドコード除去（クライアント合成 + リトライ#1）。ドキュメント更新 | 差分レビュー / soak | **切替検証後**に実施 |

> 実装フェーズ P1〜P4 は全て完了（dark）。残りは **本番切替（§7・要GO）** → 検証 → P5 デッドコード除去。

## 7. 本番切替ランブック（要 GO・:3000 再起動を伴う不可逆操作）
1. クライアントを本番ビルド: `cd EggCameraUserUI && npm run build`（フラグOFFなので**この時点では旧フロー**＝安全）。
2. `:3000` を再起動（新コード＋worker をロード。`SERVER_COMPOSITE` 未設定なら `/api/mode` は `serverCompose:false` を返し**挙動不変**）。毎時テスト緑を確認。
3. `EggCameraNode/.env` に `SERVER_COMPOSITE=1` を設定 → `:3000` 再起動 → **新フロー有効化**。
4. 検証: iPad 実機で 撮影→選択→(サーバ合成サムネ)→決定→QR、`data/jobs` の done 遷移、R2 アップロード、毎時テスト緑。
5. **ロールバック**: `.env` の `SERVER_COMPOSITE` を外す（または0）→ `:3000` 再起動。即旧フローへ。
- 注: 再起動は launchd 運用（手動 node 起動はしない）。worker は再起動後 `resumeAll` で未完了ジョブを自動再開。

### 実装メモ（P2）
- 新規: [src/jobs.js](EggCameraNode/src/jobs.js)（永続ジョブCRUD）, [src/uploadWorker.js](EggCameraNode/src/uploadWorker.js)（逐次worker・無期限バックオフ・resumeAll・sweep）。
- 変更: [config.js](EggCameraNode/src/config.js)（JOBS_DIR/TTL/backoff追加）, [routes/sessions.js](EggCameraNode/src/routes/sessions.js)（`/compose`・`/confirm`追加）, [chaos.js](EggCameraNode/src/chaos.js)（`compose`フォルト追加）, [server.js](EggCameraNode/server.js)（起動時resumeAll＋sweep間隔）。
- ジョブ自己完結: `data/jobs/<id>/` に job.json＋元写真複製＋composite.jpg。worker は composite 欠落時に元写真＋paramsから**再合成**するため、合成失敗もアップロード失敗も再起動も同一経路で復旧。
- **未デプロイ**: 本番 server は旧コードで稼働中（手動再起動はしていない）。P3でクライアントを切替＋server再起動して初めて有効化。それまで挙動は不変。

---

## 5. リスクと留意点
- **文字レンダリングのフォント実体**: 見出しフォント/Futura をサーバに配置。sharp(SVG/pango) で letterSpacing・行高に微差 → P1 で目視調整工程を確保（厳密一致は不要）。
- **プレビュー遅延**: サーバ合成（HEIC デコード+sharp）で ~1〜3s。preview にローディング UI を追加（既存 Uploading のクマ演出を流用可）。
- **ストレージ**: ジョブごとに選択 raw を複製（数 MB〜10MB/件）。完了時に破棄。disk 373GB 空きに対し問題なし。raw 本体トリムとジョブ同梱は独立。
- **フレーム抽選の移動**: サーバ抽選にし frameId をジョブに記録（再合成で同じフレーム）。
- **メール機能**: 送信基盤（Cloudflare Email Routing / SMTP）と客アドレスの PII 取り扱い。スコープを切り、最終手段として後段で実装可。
- **管理画面クロップ調整ツール**: 最終的にサーバ合成と見た目を合わせる必要（初期スコープ外・要追従）。
- **二重稼働の安全弁**: P2 でクライアント合成を残しフラグ切替にすることで、サーバ合成に不具合が出ても即ロールバック可能。

---

## 6. 確定事項（2026-06-24 ユーザー判断）
1. **合成タイミング** = **preview 入場時に合成しサムネ表示**（真の WYSIWYG）。未確定合成は短時間 TTL で掃除。
2. **メール送付（1.10）** = **アプリには実装しない**。失敗ページからの**手動ダウンロードのみ**用意し、メール送付はスタッフの手作業で行う（送信基盤も客アドレス PII もアプリで扱わない）。
3. **フレーム抽選** = **サーバ抽選**。frameId をジョブに記録し再合成で同フレーム。
4. **文字パリティ** = **デザイン準拠で目視調整**（既存 canvas との厳密一致は不要）。
5. **削除の正本** = ジョブ `uploadedAt + 24H` を正本。R2 は LastModified 基準を維持。
6. **進め方** = **Phase 1（サーバ合成エンジン）から実装着手**。

> メール機能が外れたため §3.6 の「メール送付」は実装対象外。失敗ページは「撮影日時 / QR / リアルタイム状態 / 手動DL / 再送 / 削除」までとする。
