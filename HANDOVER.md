# Session Handover — EggCamera (2026-06-13)

## TL;DR
- **Active repo: `~/EggCamera`**, branch `feature/backend-integration`.
- A deploy of the **iPhone power-saving feature is IN PROGRESS and currently
  BLOCKED** by an iPhone WiFi **IP drift** (`192.168.10.109` → `192.168.10.102`).
  The iPhone app itself is healthy; node/Mac just can't locate it.
- **soak は停止中**（最後のテストは ~15:48 UTC）。再開前に DEPLOY-MARKER 運用を厳守。

## いま何をしていたか
iPhone の 24/7 発熱・電池劣化対策の実装＆デプロイ。きっかけは「UPSがMacを落とすと
iPhone給電も切れる」→ 充電器(MagSafe)構成の検討 → コードを見たら **画面が常時点灯
＋カメラセッション回しっぱなし**で、撮影と無関係に常時 3〜5W 消費していたと判明。

### 実装した機能（コミット済み）
- **① 画面消灯**: 起動時に `UIScreen.main.brightness = 0`（`isIdleTimerDisabled=true`
  は維持＝自動ロックさせない）。iPhone画面は誰も見ない（プレビューは `/frame` で
  iPadへ）ので機能影響なし。
- **② オンデマンドのカメラ**: 180秒アクティビティ無しで `stopSession()` 自動スリープ。
  iPad の**スタート押下**で先行起動（撮影ページの待ち時間ゼロ）。撮影時は遅延起動の
  保険つき（wake取りこぼしでも撮影成立）。

### 関連コミット（このセッション）
- `ccf345f` feat(iphone): dark idle screen + on-demand camera wake
- `6e5908c` feat(admin): ADMIN_TOKEN を全呼び出し元に対応（**有効化済み・稼働中**）

### 変更ファイル
- iPhone: `EggCameraIPhone/{CameraController,AppViewModel,CaptureCommandServer}.swift`
- Node: `EggCameraNode/src/preview.js`（`wake()` 追加）, `server.js`（`POST /api/preview/wake` 公開）
- iPad: `EggCameraUserUI/src/{api.ts,App.tsx}`（`wakeCamera()` を Start で発火）

## デプロイ進捗
| 手順 | 状態 |
|---|---|
| 開始 DEPLOY-MARKER 投稿 | ✅ |
| iPad UI 再ビルド（`EggCameraUserUI/dist`） | ✅ |
| node 再起動（`launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`） | ✅ `/api/preview/wake`=200 |
| iPhoneアプリ 入れ直し（`./iphone.sh run`） | ✅ ビルド成功・起動（PID 947） |
| **E2E 確認** | ❌ **IPドリフトでブロック** |
| 完了 DEPLOY-MARKER | ⬜ 未 |

## ブロッカー：iPhone の IP が変わった
- 旧 `192.168.10.109` は arp で `(incomplete)`＝もう居ない。
- 現在 **`192.168.10.102:8080/frame` = 200**（アプリは健全、私のコードも正常動作）。
- node の Bonjour 発見が再起動(16:21)以降**未解決** → `/api/preview/frame`・
  `/api/preview/wake` が `{ok:false}`（`iphone_not_found`）。
- Bonjour 広告自体は出ている（`dns-sd -B _eggcamera._tcp` で見える）が、
  `includePeerToPeer=true` のためか v4 解決が peer-to-peer 側に寄り、
  通常WiFiの `.102` を node が掴めていない疑い。

### デプロイ前から予兆あり（重要）
`~/Library/Logs/eggcamera-node.err` に、デプロイ(16:21)**前**の 15:44〜15:48 で
soak の `capture_timeout` が多発。→ IPドリフトはデプロイ前から始まっており、
**Mac→iPhone の撮影トリガが届かず撮影失敗**していた可能性が高い（私の入れ直しで
`.109→.102` に再ドリフト）。**この障害は私の変更が原因ではない**。

## 根本原因
iPhone が **動的IP＋プライベートWiFiアドレス**。再起動/リース更新でIPが変わり、
- IPをハードコードした参照（bot の `IPHONE_FRAME` 既定 `…109`、Mac側トリガ経路の可能性）が断
- IP非依存のはずの node Bonjour も現状 `.102` を解決できていない

## 次の一手
1. **即時復旧**
   - node Bonjour が `.102` を掴めない原因切り分け（`preview.js` の解決ロジック／
     peer-to-peer広告の影響）。暫定で `.102` 直結でプレビュー疎通確認。
   - **EggCameraMac が iPhone をどう探すか**を確認（ここが `capture_timeout` の主因の疑い）。
2. **恒久対策（推奨）**
   - ルータ `aterm.me`(192.168.10.1) で iPhone に **DHCP固定割当**。
   - iPhone 設定 → 当該SSID → **「プライベートWiFiアドレスをオフ/固定」**（MAC固定で
     DHCP予約が安定）。これでIPが二度と動かず、Bonjourもハードコード参照も安定。
3. IP参照を Bonjour か固定IPへ寄せる（bot `IPHONE_FRAME` 等）。

## 確認に使うコマンド
```bash
# iPhone 実機の現在地（IPは変わり得る）
for ip in 192.168.10.{100..130}; do
  printf "$ip "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 2 http://$ip:8080/frame; done | grep 200
# Bonjour 広告確認
( dns-sd -B _eggcamera._tcp local & p=$!; sleep 5; kill $p )
# node 経由（発見できていれば 200 / ok:true）
curl -s http://localhost:3000/api/preview/frame -o /dev/null -w "%{http_code}\n"
curl -s -X POST http://localhost:3000/api/preview/wake
# node ログ（発見/プレビュー）
grep -iE "preview|discover" ~/Library/Logs/eggcamera-node.out | tail
# 管理API（ADMIN_TOKEN 必須）
TOK=$(sed -n 's/^ADMIN_TOKEN=//p' EggCameraNode/.env | tr -d '[:space:]')
curl -s "http://localhost:3000/api/admin/logs?since=0" -H "X-Admin-Token: $TOK"
```

## ロールバック（必要時）
- iPhone省電力を戻すなら `git revert ccf345f` → `./iphone.sh run`。ただし発熱問題は
  再発するため、IPを固定したうえで再デプロイするのが本筋。

## 環境メモ
- iPhone: 「YUSHINのiPhone」(iPhone 17), core-id `EE28FFF6-9D8C-5321-A6F5-CDF5467D3B02`,
  bundle `com.siggaze.eggcamera`, team `4U78CNU7WN`, cert `siggaze.0000@gmail.com`.
- ポート: node `:3000` / EggCameraMac trigger `:8082`・callback `:8081` / iPhone `:8080`。
- 常駐(launchd): `com.eggcamera.{node,mac,bot,soak-watch,iphone-refresh,backup,heartbeat}`。
- ADMIN_TOKEN は `EggCameraNode/.env`（gitignore）。管理画面: `http://10.99.99.1:3000/admin?token=…`。
- DEPLOY-MARKER 運用必須（テスト影響操作の前後で `/api/test-report` にマーカー投稿）。

## 別スレッド（ソーク監視）の引き継ぎ
> 注記: 監視スレッドが HANDOVER.md に追記した内容を、当方の全文上書きで誤って消失
> させた（git未追跡のため復元不可）。以下は**無傷の `SOAK-HANDOVER.md`** から要点を
> 再リンクしたもの。一次情報は必ず `SOAK-HANDOVER.md` を参照。

- **テスト構成**: テスト拡張(EggCameraTestExt)は **WindowsタブレットのChrome**、サーバ
  (:3000)・リポジトリは **Mac mini(192.168.10.104)**。拡張更新はzip配布
  (`http://192.168.10.104:3000/EggCameraTestExt.zip`)。zipは `EggCameraUserUI/dist/` 配下
  にあるため **UI再ビルドで消える**（消えたら `zip -r EggCameraTestExt.zip EggCameraTestExt` で再生成）。
- **ソーク偽陽性対策**（content.js / hook.js / src/chaos.js）はコミット済みだが、
  **拡張リロード＋サーバ再起動で有効化**。未有効化中の既知の偽陽性（統計「注入0」、
  多重注入後の「▲ 注入なしでオーバーレイ」等）は報告対象外。
- **ストレージリーク修正**（src/composite.js）: `data/raw/.preview` が無掃除で 2.1GB/611
  ファイル蓄積 → `trimLocalDir(PREVIEW_DIR, …)` を追加（**サーバ再起動後に有効**）。
  溜まり分は手動掃除済み。
- **iPhone 熱監視**（← 今回の省電力①②と直結）: 監視スレッドは「**1サイクル所要時間の
  漸増**」を iPhone 発熱の代理指標にしている。①②（画面消灯＋カメラ待機スリープ）デプロイ後は
  この指標が改善するはず。E2E 復旧後に確認すると効果検証になる。
- **監視体制**: 毎時 :06/:36 に `node tools/check-soak.js 35` ＋ `node tools/check-r2-cost.js`。
  チェックリスト・リソース棚卸し・新ログの読み方は `SOAK-HANDOVER.md` に詳述。
- **このセッションで追加したトークン対応**: `tools/check-soak.js` は ADMIN_TOKEN を
  `../.env` から読んで送るよう更新済み（`6e5908c`）。recover.sh / Slack bot も同様。

---

## 監視スレッド追記（2026-06-14 01:35）

### EggCameraMac NWConnection 障害の調査・修正

#### 根本原因（新規特定）
`lsof` で EggCameraMac のアウトバウンド TCP がゼロと判明（リスナー 8081/8082 のみ）。
`curl` / Node.js raw TCP では iPhone:8080 に即 202 → 写真届く。NWConnection だけ通らない。

**原因：バイナリに Info.plist が埋め込まれていなかった** → macOS TCC がローカルネットワーク
許可ダイアログを表示できず、NWConnection が `.waiting` のまま無応答・デッドロック。

#### 実施した修正（ビルド済み・稼働中）

1. **`EggCameraMac/Info.plist`** に以下を追加：
   - `NSLocalNetworkUsageDescription`（許可ダイアログ説明文）
   - `NSBonjourServices: [_eggcamera._tcp]`
   - `CFBundleIdentifier: com.eggcamera.mac`（`$(PRODUCT_BUNDLE_IDENTIFIER)` → 実値）

2. **`EggCameraMac/Package.swift`** に linkerSettings を追加：
   ```
   -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
   ```
   → `plutil` で埋め込み確認済み（`com.eggcamera.mac`、`NSLocalNetworkUsageDescription` 記載）

3. **`swift build -c release` → `launchctl kickstart` で再起動済み**（PID 37323、01:09:49 起動）

#### 現在の状態（ブロック中）

- `[test-local-net] Sending capture command`（01:11:44）から TCP 接続が確立しないままデッドロック中
- macOS がローカルネットワーク許可ダイアログを表示しているはず（または System Settings 待ち）

#### 復旧手順

**ステップ 1：許可を付与する**

方法A（プロファイル）：
```bash
open /Users/eggcamera/EggCamera/EggCameraMac/EggCameraMac-LocalNetwork.mobileconfig
```
→ 「インストール」→ パスワード入力

方法B（手動）：システム設定 → プライバシーとセキュリティ → ローカルネットワーク → EggCameraMac を ON

**ステップ 2：再起動**
```bash
launchctl kickstart -k gui/$(id -u)/com.eggcamera.mac
```

**ステップ 3：動作確認**
```bash
curl -X POST http://localhost:8082/capture \
  -H "Content-Type: application/json" \
  -d '{"triggerId":"test-permission-ok"}'
# → data/logs/swift/app.log に "Received photo" が出れば完全復旧
```

**ステップ 4：ソークテスト再開**
```bash
cd EggCameraNode && node tools/api-soak.js
```

#### 備考
- `data/raw/` 最終保存：`20260614_005156.heic`（00:51:56、curl 直接テスト分）
- NWConnection 修復後は iPhone IP が `.102` で固定されていることを前提とした直接接続になる
  （`EggCameraMac/config.json` の `iphoneHost: "192.168.10.102"` — デプロイスレッドが設定済み）
- iPhone 省電力（`ccf345f`）デプロイ後の E2E 確認もこのタイミングで兼ねて実施可能

---

## 解決（2026-06-15 16:45 JST）— USB制御へ全面移行（`eb310cb`）

WiFi制御が全障害（IP漂流・WiFi断・Bonjour失敗・ローカルネットワーク許可
デッドロック）の根本原因と判明。Mac↔iPhone を **USB(iproxy)** に全面移行して解決。

- **iproxy(libusbmuxd)** が Mac `localhost:8080` → iPhone:8080 を **USB** でフォワード。
  launchd 常駐（`~/Library/LaunchAgents/com.eggcamera.iproxy.plist`、KeepAlive、UDID
  `00008150-00184D192299401C`、リポジトリ控え `ops/launchd/`）。
- **プル型**: iPhone は POST `/capture` のレスポンスで写真(UploadEnvelope JSON)を返す
  （旧 callback→Mac:8081 のWiFi逆POSTは廃止）。iPhone待受は素のTCP（Bonjour/peer-to-peer
  廃止→loopbackにバインドされUSB到達可能に）。
- `config.json iphoneHost=127.0.0.1`（localhost は TCC 対象外 → **ローカルネットワーク
  許可問題も消滅**）。node preview/wake も `127.0.0.1:8080`。
- **E2E検証OK**: USB撮影 200/5.77MB/1.5s、Mac トリガ→`data/raw/`保存、Node セッション
  撮影→photoId、preview/frame 200、wake ok:true。**WiFi未使用**。省電力①②も維持。

### 残・注意
- **無料プロビジョニングの宿命**: 開発者証明書のオンライン照合に iPhone のネットが要る
  （今回「アプリを検証できません/インターネット接続が必要」で詰まり、WiFi接続＋「信頼」で解決）。
  週次の再署名(`iphone-refresh`)後も再照合が要り得る → **iPhoneはWiFi接続を維持**しておく
  （操作はUSBだが証明書照合のため）。恒久安定には **有料Apple Developer($99/年)** 推奨
  （7日失効・週次再署名・オンライン照合が全て不要に）。
- macOS自動更新の自動再起動は停止済み（`AutomaticallyInstallMacOSUpdates=false`）。
