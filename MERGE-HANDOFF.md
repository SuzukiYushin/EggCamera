# マージ引き継ぎ — refactor/modular-resilience（障害分離リファクタ）

別スレッドがこのブランチを本番へマージ・デプロイするための引き継ぎ。
**必ず `REFACTOR-PLAN.md` も併読**（設計と全手順）。

## TL;DR
- ブランチ **`refactor/modular-resilience`**（worktree `/Users/eggcamera/EggCamera-refactor`）。
  本番 `feature/backend-integration`（HEAD `eb310cb`）から **10コミット**。本番 `/Users/eggcamera/EggCamera` は走行中で**未変更**。
- 目的: **一箇所のバグで全停止しない**（障害分離）。worktree で実装＋検証済み（admin kill→core撮影パス無事をkillテストで確認）。
- 適用は**本番停止枠**で。下記「BEFORE merge」を必ず先に。

## このブランチで入るもの（10コミット）
```
9be6933 Phase1仕上げ: 外部呼出し(R2/Mac)タイムアウト＋保守ジョブ安全化
f32b29f ops消費側を admin:3001 へ追従（bot/check-soak/recover）
5440d68 Phase2: admin別プロセス分離(:3001)  ← 本丸
4f4fd82 ログのファイル化(app.jsonl)
0a0eadb DEPLOY-MARKER修正(recover.sh) ＋ 死にポート:8081を健全性判定から除外
38722bb reboot password を env専用・fail-closed（コードから familiar1234 完全削除）
7ebe02f iPhone接続をconfig集約・stale IP(192.168.10.109)排除
a2a4448 Phase3: カメラ差し替え可能アダプタ化
e2b62a9 Phase1: 全ルートのエラーバウンダリ＋安全ジョブ
（＋ REFACTOR-PLAN.md / MERGE-HANDOFF.md）
```

## ⚠️ BEFORE merge（これを忘れると壊れる）
1. **`EggCameraNode/.env` に `REBOOT_PASSWORD` を設定**（人が手入力）。
   未設定だと再起動API＝**503 fail-closed**（既定値はコードから削除済み）。値はコード/リポジトリに書かない。
2. **管理画面URLが変わる**: `:3000/admin` → **`:3001/admin`**。Cloudflare Tunnel に **:3001 のルート**を追加すること。
3. soak を**停止**し、`/api/test-report` に **DEPLOY-MARKER** を投稿してから作業（無いと監視が誤検知）。

## マージ＆デプロイ手順（本番 `/Users/eggcamera/EggCamera`）
```bash
cd /Users/eggcamera/EggCamera
# 0) soak停止 + マーカー
curl -s -X POST http://localhost:3000/api/test-report -H 'Content-Type: application/json' \
  --data '{"level":"info","text":"DEPLOY-MARKER(merge): 障害分離リファクタ(admin別プロセス等)を本番へ適用。一時的API断は本作業由来。"}'
# 1) .env に REBOOT_PASSWORD を設定（手入力。例: $EDITOR EggCameraNode/.env）
# 2) マージ
git checkout feature/backend-integration
git merge refactor/modular-resilience
# 3) admin常駐を登録
cp ops/launchd/com.eggcamera.admin.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.eggcamera.admin.plist
# 4) core(node) 再起動（adminCore反映・/admin静的配信停止）
launchctl kickstart -k gui/$(id -u)/com.eggcamera.node
# 5) bot 再起動（admin:3001 参照へ）
launchctl kickstart -k gui/$(id -u)/com.eggcamera.bot
# 6) Cloudflare Tunnel に :3001 ルート追加（管理画面用）。完了マーカー → soak再開
```

## デプロイ後の検証チェックリスト
- [ ] core 撮影: `curl -XPOST localhost:3000/api/sessions` → sessionId
- [ ] core プレビュー: `localhost:3000/api/preview/frame` → 200（USB iproxy 経由）
- [ ] admin 稼働: `launchctl list | grep eggcamera.admin`、`localhost:3001/admin/` → 200
- [ ] admin ローカルAPI: `localhost:3001/api/admin/maintenance` → JSON
- [ ] admin→coreプロキシ: `localhost:3001/api/admin/metrics` → core のrss
- [ ] soak経路(変更なし): `localhost:3000/api/admin/chaos` → 200
- [ ] 再起動API: token+REBOOT_PASSWORD で実行可（未設定なら503になる＝.env要確認）
- [ ] **障害分離**: admin を一時 kill（`pkill -f admin-server.js`）→ core 撮影が無事 → launchd が admin 再起動
- [ ] `/egg status`（bot）でディスク/失敗/メモリが出る、`node tools/check-soak.js` が動く

## 壊してはいけない点（重要）
- **長期運用テスト拡張(content.js)は :3000/api/admin/{chaos,metrics} を直接叩く**。これらは **core(:3000) に残してある**ので拡張は変更不要。**admin移行で :3000 の chaos/metrics を消さないこと**。
- core(:3000) が serve するのは adminCore（metrics/test-capture/chaos/selftest）のみ。**管理UI・frames・settings・logs・diagnose・failed・restart は :3001**。
- soak が走行中は触らない。停止枠でのみ。

## ロールバック
```bash
git checkout feature/backend-integration
git reset --hard eb310cb           # マージ前へ
launchctl bootout gui/$(id -u)/com.eggcamera.admin 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.eggcamera.node
# 管理画面は再び :3000/admin（トンネルのルートを戻す）
```

## 環境メモ
- ポート: core `:3000` / **admin `:3001`(新)** / Mac trigger `:8082` / iPhone `:8080`(USB iproxy)。
- ops消費側の admin先は env で上書き可: bot `EGG_ADMIN_URL`、check-soak/recover `ADMIN_PORT`/`ADMIN_URL`（既定 :3001）。
- worktree には検証用に `node_modules` シンボリックリンク＋テスト用 data/ がある（gitignore・無害）。
- 死にコード（iPhone `TransferClient` / Mac `UploadReceiverServer`）は**今回は未除去**（Swift再ビルドを伴うため別枠）。健全性判定からは既に除外済み。

## 残（任意・次枠）
- 死にコード除去（iPhone/Mac、Swift再ビルド）。
- `adapters/storage`(R2)・`adapters/notify`(Slack) の境界化（`composite.js` を imaging/storage に分割）。
