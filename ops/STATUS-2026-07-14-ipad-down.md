# 運用状況メモ — iPad不通期間（2026-07-13 〜 2026-07-15予定）

最終更新: 2026-07-14 09:30 JST / 記録者: Claude（post-boot復旧セッション）

iPadを刺し直せるのが **2026-07-15**（明日）のため、それまでは **iPadが無い前提**で運用する。
本ファイルはその間の状況・変更・復帰手順の記録。iPadを刺したらこのファイルの「復帰手順」を実行する。

---

## 1. いま何が起きているか

| 対象 | 状態 |
|---|---|
| iPad（キオスク本体） | ❌ **完全オフライン**。USB(usbmux/devicectl=unavailable)・Wi-Fi(192.168.10.112 応答なし)・WDA/フォワーダ すべて不通 |
| iPhone（カメラ） | ✅ 正常（`:8080/frame` = 200、実撮影OK） |
| node(:3000) / admin(:3001) | ✅ 正常 |
| Appium(:4723) / cloudflared | ✅ 正常（トンネル4接続） |
| 毎時テスト | ⚠️ iPadを使わない**API E2Eへフォールバック中**（後述） |
| 毎時:50 Claude総合点検 | ❌ **認証切れで停止中**（2026-07-12 17:50〜。要 `claude setup-token`） |

**顧客影響**: キオスク端末が止まっているため、**店頭での撮影サービスは停止中**。
バックエンド（撮影→合成→R2→DL）は健全で、API E2Eで継続検証している。

### iPadが落ちた経緯
- 2026-07-12 18:18 の毎時テストまでは正常（完了5/フォルトOK1）
- 18:30 の `ipad-sleep` が「フォワーダ無応答 → WDA復旧失敗 → スリープ断念」
- 以後ずっと不通。07-13 08:34 の自動復帰も失敗し、ログは「要人間対応(iPad画面を物理タップ)」
- 07-13 00:15 の Mac 再起動を境に、毎時テストが `SKIP(alert)` を検知・通知するようになった
- devicectl でも Wi-Fi でも見えない＝**電源が落ちている可能性が高い**（バッテリー枯渇 or USB給電断）

### 監視の穴（発見して修正済み）
07-12 19:00〜07-13 00:13 の6枠は、Appiumのセッション起動失敗で**1サイクルも走っていないのに
「完了0 失敗0 rc=0 ＝ 正常完走」として無音で流していた**。`hourly-ipad-test.sh` を修正し、
完了0はアラート扱いにした（commit `42eee04`）。

---

## 2. iPad不在中の運用（実装済み・稼働中）

### 毎時テスト＝API E2Eへ自動フォールバック（commit `42eee04`）
iPadがUSBレジストリ(:42314)にもWi-Fi WDAにも居ない場合、SKIPせず
`EggCameraNode/tools/prod-e2e.js` を回す。**キオスクUI(Safari操作)以外の本番実パスは全部検証される**:

```
POST /api/sessions → capture×3(iPhone実撮影) → POST /compose(サーバ側sharp合成)
→ POST /confirm(QR発行+uploadWorker投入) → GET /api/jobs/:id/status(アップロード完了待ち)
→ DLページ200 + R2画像200 → 写真3枚・status=done の不変条件チェック
```

- 手動実行: `cd EggCameraNode && node tools/prod-e2e.js --cycles 3`
- 失敗時のみ Slack 通知（正常時は `/api/test-report` に info のみ）
- 実測: 合成 ~810ms、完成画像 ~1.5MB、RSS 90MB前後

※ `tools/api-soak.js` は**旧クライアント合成パス(/composite)・撮影1枚**しか叩かず、
現行のサーバ合成(compose/confirm/uploadWorker)を検証できない。使うなら `prod-e2e.js` の方。

### iPad物理対応リマインダの抑止
`ops/ipad/.ipad-down-until` に **`2026-07-15`** と記載済み。この日までは Slack リマインダを出さない
（ログには残る）。**期限を過ぎると自動でリマインダが復活する**ので、放置しても忘れない。

---

## 3. iPadを刺したらやること（復帰手順）

1. **iPadをUSB-Cで接続 → 画面を物理タップして起こす**（電源が落ちていれば電源ON・充電確認）
2. 認識確認:
   ```sh
   xcrun devicectl list devices | grep -i ipad          # State=connected になるか
   curl -s http://127.0.0.1:42314/remotexpc/tunnels     # UDID 00008132-001E2934019A401C が居るか
   ```
   居なければ: `sudo launchctl kickstart -k system/com.eggcamera.appium-tunnel`
3. **ack を削除**（消し忘れても 07-15 で自動失効するが、明示的に消すのが正）:
   ```sh
   rm -f /Users/eggcamera/EggCamera/ops/ipad/.ipad-down-until
   ```
4. Wi-Fiモードのフラグ（`ops/ipad/.wda-wifi-mode`）は**現在存在しない**＝USB前提。USB復旧ならそのままでよい
5. 次の毎時枠（:00 / :30）で自動的に iPad 6サイクルテストへ戻る。戻ったことの確認:
   ```sh
   tail -20 ~/Library/Logs/eggcamera-hourly-test.log   # 「毎時テスト開始」→「完了: 完了6 …」
   ```
6. **キオスク画面の復帰確認**（Safariが `http://192.168.10.104:3000/` を開いているか）
7. **今日の変更のUI確認**（下記4章。iPadでしか見られない）

---

## 4. iPad不在中に入れた変更（要・実機UI確認）

| commit | 内容 |
|---|---|
| `3a052fa` | 完成画像を **2:3(4000×6000) → iPhone画面比 2768×6000** へ変更。成長フレーム11枚を再生成。管理画面のWYSIWYG/画素数ゲージも同値に。rawを **iPhoneネイティブ保存**へ（Mac側cropCenter廃止・Swift無改修/config.jsonのみ）。合成の**向きバグ**修正（sipsのHEIC→JPEGはEXIF orientationを素通し・sharpは自動回転しないため90°倒れていた → `.rotate()` 追加） |
| `42eee04` | 毎時テストのiPadなしフォールバック＋「完了0」無音バグ修正＋`tools/prod-e2e.js` 新設 |

**iPad実機で見ないと確認できないもの**:
- FinalPreview（決定画面）のプレビュー比が 2768:6000 で崩れていないか
- 撮影〜決定〜QRまでのキオスク実操作
- **物理フレーミング**: 完成画像が横に31%狭くなったので、iPhoneの設置画角の再調整が要る可能性が高い（赤ちゃんが窮屈に写らないか）

---

## 5. 未解決（人間タスク）

1. **iPadの物理復旧** — 明日（07-15）実施予定
2. **毎時:50 Claude総合点検の認証切れ** — `claude setup-token` で長期トークンを発行し
   `EggCamera/.env.claude` に `CLAUDE_CODE_OAUTH_TOKEN=…` として置く（`.gitignore` 追加済み）。
   `ops/ipad/hourly-claude-watch.sh` と `ops/run-recovery-claude.sh` が自動で読む。
   現状は launchd から起動する度に `Failed to authenticate: OAuth session expired` で即死しており、
   **総合点検が18時間以上まったく動いていない**。
3. **通常フレーム素材の作り直し** — `frames.json` 登録分(10014×17793 = 比0.563)は
   `fit:'fill'` で新アスペクトへ引き伸ばされる。GROWTH_FRAMES=1 の間は使われないが、いずれ要対応。
