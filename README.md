# Egg Camera

Baby photo booth system. iPhone captures photos, Mac mini composites and uploads to Cloudflare R2, iPad displays the user flow.

## System Overview

```
Node.js (timer) → Swift Mac app → iPhone (capture)
                                       ↓
                              data/raw/*.heic
                                       ↓
                        Node.js (composite + upload)
                                       ↓
                    data/composited/*.jpg   Cloudflare R2
                    data/qrcodes/*.png
```

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
```

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

### 5. Build Swift App

```bash
cd EggCameraMac
swift build -c release
cd ..
```

### 6. Verify Data Directory

以下のディレクトリが存在することを確認：

```
data/
├── raw/               ← Swift が写真を保存（自動作成）
├── composited/        ← Node.js が合成画像を保存（自動作成）
├── qrcodes/           ← Node.js が QR コードを保存（自動作成）
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

---

## Startup

**ターミナル 1 — Swift (Mac camera controller):**

```bash
cd EggCameraMac
.build/release/EggCameraMac
```

**ターミナル 2 — Node.js (compositor + trigger):**

```bash
cd EggCameraNode
node index.js
```

正常起動時のログ例：

```
[...] Watching ../data/raw
[...] Trigger: host=localhost port=8082 interval=5000ms
[...] t-1 → 202
```

### Environment Variables (optional)

```bash
INTERVAL_MS=10000 node index.js   # 撮影間隔を10秒に変更
SWIFT_HOST=192.168.1.x node index.js   # iPhone に直接接続する場合
```

---

## Configuration

`EggCameraMac/config.json` の主要項目：

| Key | Default | Description |
|---|---|---|
| `iphonePort` | `8080` | iPhone アプリのポート |
| `callbackPort` | `8081` | Mac が写真を受け取るポート |
| `triggerPort` | `8082` | Node.js からのトリガー受信ポート |
| `outputWidth/Height` | `4000/6000` | 出力解像度 |
| `receivedPhotosDirectory` | `../data/raw` | 生写真の保存先 |

---

## Notes

- **R2 retention**: 3日（`R2_RETENTION_MS` in `index.js`）。検証時は `3 * 60 * 1000`（3分）に変更可。
- **Local photo limit**: `raw/` と `composited/` はそれぞれ最大30枚。アプリ再起動後もディスク上のファイル数をもとに計算。
- **iPhone lock prevention**: アプリ起動中は `isIdleTimerDisabled = true` で画面ロックを抑制。
- **Session interruption**: カメラセッションが中断された場合（ロック等）、解除後に自動復帰。
