# iPad Safari フルフロー自動テスト

## ファイル構成

| ファイル | 役割 | 本番デプロイ |
|---|---|---|
| `ipad-test.js` | メインスクリプト（フォトブースフロー・DL検証・ログ確認） | ✅ そのまま使う |
| `ipad-test-harness.js` | テストハーネス（フォルト注入・QUIRKS・goBack） | ❌ **削除する** |

---

## 本番デプロイ時

```bash
rm EggCameraNode/tools/ipad-test-harness.js
```

これだけ。`ipad-test.js` はハーネスファイルが見つからなければ自動的に全スタブへ切り替わる。フォルト注入・chaos API 呼び出し・hook.js 注入は一切実行されない。

---

## 起動

```bash
# テスト環境（ipad-test-harness.js が存在する状態）
node EggCameraNode/tools/ipad-test.js

# 本番モード確認（ハーネスなしで動作テスト）
mv EggCameraNode/tools/ipad-test-harness.js /tmp/ && node EggCameraNode/tools/ipad-test.js
```

起動ログに `テストハーネス: 有効` / `テストハーネス: なし（本番モード）` が出る。

---

## フロー概要

### Phase 1 — 前処理
- 残留サーバフォルトを掃除（ハーネスあり時のみ）
- `buildPlan()` でサイクルの計画を決定
- `localStorage.eggcamera-admin-busy` を確認 → セット済みならスキップ

### Phase 2 — フォトブースフルフロー
1. 言語選択（日本語）→ はじめる → スキップ × 2
2. 撮影 → 決定ボタン待機（最大30秒）
3. この写真を保存する

### Phase 3 — QR画面待機
- 固定 185 秒待機（QR表示は3分固定、余裕5秒込み）
- はじめに戻る をタップして TOP へ

### Phase 4 — 検証
- QR ID を管理ログから取得
- `https://eggcamera.pages.dev/image/<ID>.jpg` へ DL 検証（200 & 100KB超で合格）
- HDD 空き容量確認
- 管理ログ確認（サイクル開始以降の `想定外|コスト警告|▲`）
- `/api/test-report` へ結果投稿

---

## テストハーネスの機能

### フォルト注入（8% / サイクル）

フォルトカタログは Chrome 拡張と同一の 10 種。ローテーション管理ファイル: `/tmp/ipad-fault-index.json`

| ID | 種別 | 内容 | オーバーレイ期待 |
|---|---|---|---|
| `session-create` | client | セッション作成 POST → 500 | ✅ |
| `capture-502` | client | 撮影 POST → 502 | ✅ |
| `capture-server` | server | 撮影失敗（chaos API） | ✅ |
| `frames-api` | client | フレーム一覧 GET → ネットワーク断 | ❌ |
| `settings-api` | client | 設定 GET → ネットワーク断 | ❌ |
| `composite-upload` | client | 合成アップロード POST → 500 | ✅ |
| `r2-server` | server | R2 アップロード失敗（chaos API） | ❌ |
| `qr-server` | server | QR 生成失敗（chaos API） | ✅ |
| `session-poll` | client | セッションポーリング × 25 → ネットワーク断 | ✅ |
| `js-error` | js | フロント JS 実行時エラー（5秒後） | ✅ |

多重注入確率: 2 個同時 15% / 3 個 7% / 4 個 3%（同一グループは除外）

**client フォルト**: `EggCameraTestExt/hook.js` をページに注入し `window.fetch` をフック  
**server フォルト**: `POST /api/admin/chaos` で chaos カウンタをセット

オーバーレイ期待ありのフォルトでエラーオーバーレイが確認できたら「フォルト検証OK」として正常終了。
期待なし or フォルトなしで出た場合は「想定外オーバーレイ」として Slack 通知＋アラート。

### QUIRKS（15% / サイクル、フォルトなし時のみ）

| QUIRK | 内容 |
|---|---|
| `shutter-mash`（× 2） | 撮影ボタン連打 × 6 |
| `idle-pause` | 名前入力画面で 75 秒放置 |
| `double-click`（× 2） | 保存ボタン二度押し |
| `reload-midflow` | 撮影直後にページリロード → フローを最初からやり直し |

### goBack（15% / サイクル）

撮影確認画面（決定ボタン出現後）で「戻る」をタップして撮りなおし。

---

## 依存関係

```
ipad-test.js
└── ipad-test-harness.js（オプション）
    └── ../../EggCameraTestExt/hook.js
```

Appium: `http://127.0.0.1:4723`  
WebDriverIO: `/Users/eggcamera/ios-safari-mcp/node_modules/webdriverio`  
iPad UDID: `00008132-001E2934019A401C` / iPadOS `26.5`  
WDA: prebuilt (`appium:usePrebuiltWDA: true`)
