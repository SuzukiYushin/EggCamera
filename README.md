# Egg Camera

Baby photo booth system. iPhone captures photos, Mac mini composites and uploads to Cloudflare R2, iPad displays the user flow.

## System Overview

```
iPad (kiosk UI) ⇄ Node.js (Express: REST API + 静的UI配信, :3000)
                          │ POST /capture（オンデマンド）
                          ▼
                   Swift Mac app (:8082) → iPhone (capture)
                          │
                   data/raw/*.heic
                          │
                   Node.js (HEIC→JPEG preview, composite + R2 upload + QR)
                          │
        data/composited/*.jpg ──▶ Cloudflare R2 ──▶ QR (data URL, iPadへ返却)
```

UIからの操作はすべて `/api/sessions/...` 経由のオンデマンドリクエスト。Node.jsの自動撮影タイマーは廃止済み。

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production / delivery |
| `develop` | Long-term operation test (Mac mini) |
| `feature/*` | Feature development → PR to `develop` |

---

## Mac mini Setup

### 1. Prerequisites

```bash
# Xcode Command Line Tools (includes Swift)
xcode-select --install

# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js
brew install node
```

Verify:
```bash
swift --version   # Swift 6.x
node --version    # v23.x
```

### 2. Clone Repository

```bash
git clone https://github.com/SuzukiYushin/EggCamera.git
cd EggCamera
git checkout develop
```

### 3. Create `.env`

```bash
cp EggCameraNode/.env.example EggCameraNode/.env   # なければ手動で作成
```

`EggCameraNode/.env` に以下を記入（値は別途共有）：

```
R2_ACCOUNT_ID=Cloudflareから取得してください
R2_ACCESS_KEY_ID=Cloudflareから取得してください
R2_SECRET_ACCESS_KEY=Cloudflareから取得してください
R2_BUCKET_NAME=eggcamera-photos
R2_PUBLIC_BASE_URL=https://pub-c35d182b845942f3b26d0ed65d668e0d.r2.dev
PAGES_BASE_URL=https://eggcamera.pages.dev

# ── Server ──────────────────────────────────────────────
PORT=3000
STATIC_DIR=

# ── Capture trigger (Mac TriggerReceiverServer) ──────────
SWIFT_HOST=localhost
SWIFT_PORT=8082
CAPTURE_TIMEOUT_MS=25000

# ── Sessions ──────────────────────────────────────────────
SESSION_TTL_MS=1800000
```

> `Server` / `Capture trigger` / `Sessions` セクションは未記載でもデフォルト値で動作します（Mac mini上でSwiftアプリと同居する通常構成ならそのままでOK）。

> `.env` は git 管理外のため、MacBook から `scp` で転送するか手動で作成。
> ```bash
> # MacBook 側で実行
> scp EggCameraNode/.env [user]@[mac-mini-ip]:~/EggCamera/EggCameraNode/.env
> ```

### 4. Install Node.js Dependencies

```bash
cd EggCameraNode
npm install
cd ..
```

### 5. Build the iPad UI

EggCameraNode が `EggCameraUserUI/dist` をそのまま静的配信するため、事前にビルドしておく。

```bash
cd EggCameraUserUI
npm install
npm run build   # → dist/ を生成
cd ..
```

### 6. Build Swift App

```bash
cd EggCameraMac
swift build -c release
cd ..
```

### 7. Verify Data Directory

以下のディレクトリが存在することを確認：

```
data/
├── raw/               ← Swift が写真を保存（自動作成）
│   └── .preview/      ← Node.js が生成するプレビューJPEGキャッシュ（自動作成）
├── composited/        ← Node.js が合成画像を保存（自動作成、最新30枚を保持）
├── assets/
│   └── frames/
│       └── flame_sample.png   ← ← 必須
└── logs/
    └── swift/
```

`flame_sample.png` が存在しない場合は MacBook から転送：

```bash
scp data/assets/frames/flame_sample.png [user]@[mac-mini-ip]:~/EggCamera/data/assets/frames/
```

> QRコードはファイル保存せず、その場で data URL を生成して iPad に返すため `data/qrcodes/` は不要。

---

## Startup

**ターミナル 1 — Swift (Mac camera controller):**

```bash
cd EggCameraMac
.build/release/EggCameraMac
```

**ターミナル 2 — Node.js (UI配信 + セッションAPI):**

```bash
cd EggCameraNode
node server.js
```

正常起動時のログ例：

```
[...] EggCameraNode listening on :3000 (static: .../EggCameraUserUI/dist)
[...] R2 cleanup: N objects (...MB), M to delete
```

**iPad:**

Safari で `http://<Mac miniのIP>:3000` を開く（フルスクリーン/ガイドアクセス推奨）。UIとAPIは同一オリジンなので追加設定は不要。

### URLの使い分け（開発時）

| URL | 用途 |
|---|---|
| `http://localhost:5173/`（または `http://192.168.10.104:5173/`） | **手直し用**。Vite devサーバ。`src/` を編集すると保存した瞬間に画面へ反映（HMR）。APIは自動で `:3000` へプロキシされるので撮影等もそのまま動く |
| `http://localhost:3000/` | **本番ビルド配信**。`npm run build` するまで編集は反映されない。長期テスト・iPad実機用 |

```bash
# Vite devサーバの起動（HMR、LANからアクセス可）
cd EggCameraUserUI && npm run dev -- --host

# 本番ビルド（:3000 に反映）
cd EggCameraUserUI && npm run build
```

### Environment Variables (optional)

```bash
SWIFT_HOST=192.168.1.x node server.js   # iPhone/Mac側のトリガー受信先を変更する場合
PORT=8000 node server.js                # 待受ポートを変更する場合
```

---

## Configuration

`EggCameraMac/config.json` の主要項目：

| Key | Default | Description |
|---|---|---|
| `iphonePort` | `8080` | iPhone アプリのポート |
| `callbackPort` | `8081` | Mac が写真を受け取るポート |
| `triggerPort` | `8082` | Node.js からのトリガー受信ポート |
| `captureIntervalSeconds` | `0` | 自動撮影間隔（`0`＝無効、iPad起点のオンデマンド撮影のみ） |
| `sendCaptureOnLaunch` | `false` | 起動時の自動撮影トリガー |
| `outputWidth/Height` | `4000/6000` | 出力解像度 |
| `receivedPhotosDirectory` | `../data/raw` | 生写真の保存先 |

---

## Notes

- **R2 retention**: 3分（`R2_RETENTION_MS` in `EggCameraNode/src/config.js`）。本番運用時は `3 * 24 * 60 * 60 * 1000`（3日）等に変更。
- **Local photo limit**: `composited/` は最大30枚（`MAX_COMPOSITED`、`src/config.js`）。アプリ再起動後もディスク上のファイル数をもとに計算。`raw/` および `raw/.preview/` は自動削除されないため、定期的な手動クリーンアップを検討。
- **iPhone lock prevention**: アプリ起動中は `isIdleTimerDisabled = true` で画面ロックを抑制。
- **Session interruption**: カメラセッションが中断された場合（ロック等）、解除後に自動復帰。
- **セッションAPI**: `POST /api/sessions`（セッション作成）、`POST /api/sessions/:id/capture`（1枚撮影トリガー）、`POST /api/sessions/:id/select`（合成・R2アップロード・QR生成を開始）、`GET /api/sessions/:id`（ステータス確認）、`GET /api/photos/:photoId`（プレビュー画像）。セッションはメモリ上で管理され、`SESSION_TTL_MS`（既定30分）で自動失効。

