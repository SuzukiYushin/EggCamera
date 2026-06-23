# Cloudflare 本番アカウント移行 ランブック

最終更新: 2026-06-23（R2 / Pages / Workers は新アカウント `e6037dd3898fac341ca130b80faded3c` へ **実施済**。Tunnel/WARP と独自ドメイン付与は未実施）

この案件が Cloudflare で使っている **5系統すべて**を、現アカウント（`Siggaze.0000@gmail.com`）から
**取引先所有の本番アカウント**へ移すための実行手順書。
Tunnel/WARP の詳細だけは既存の [CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) に委ね、本書はそれ以外（R2 / Pages / Workers / 独自ドメイン）と全体のカットオーバー順序を扱う。

---

## 0. 今回の決定事項（前提）

| 項目 | 決定 |
|---|---|
| 移行先アカウント | **取引先所有**のCloudflareアカウント（自分=`creative-center@jizaie.co.jp`はAdministratorで参加） |
| 利用者向けドメイン | 取引先が**他社サービスで取得済みのドメインのサブドメイン**を新規に使う（例: `photo.例.com`）。**ゾーン移管はしない** |
| 独自ドメインの付け方 | Pagesの Custom domain として付与し、**外部DNSにCNAMEを1本**足すだけ（NS変更・DNSSEC解除・証明書再発行は不要） |
| R2写真データ | **ドレイン方式**（24h TTLで自動消滅するためコピー不要。旧アカウントを24〜48h並走させて旧QRを枯らす） |

> 以降、独自サブドメインを `photo.例.com` と表記する。**実ドメインに置換**して使うこと。

---

## 0.5 実行時の落とし穴（必読・2026-06-23 本番実施で判明）

実際に R2 / Pages / Workers を新アカウントへ移して踏んだ罠。**作業前に必ず読むこと。**

1. **wrangler の操作先アカウントに注意（最重要）**
   `wrangler` の **OAuth ログイン先**（`wrangler whoami` のアカウント）と、env で渡す `CLOUDFLARE_ACCOUNT_ID` は別物。
   今回ログインは**旧アカウントのまま**で、`wrangler kv namespace create WATCHDOG` が「already exists」になったのは
   **旧アカウントの名前空間を見ていただけ**だった（新アカウントには無かった）。
   → **新アカウントを対象にする全 wrangler コマンドは、先に `~/EggCamera/.env.cloudflare` を source** して
   `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` を env 注入する（Pages の deploy.sh と同じ流儀）。
   例: `set -a; source ~/EggCamera/.env.cloudflare; set +a; npx wrangler deploy`
   逆に**旧アカウント**を対象にしたい時（旧Worker削除など）は env を `unset` し、`wrangler whoami` が旧であることを必ず確認する。

2. **`.env.cloudflare` のトークン権限不足**
   Pages だけのトークンだと Workers/KV の API が `Authentication error (10000)` になる。
   トークンに **Workers Scripts:Edit** と **Workers KV Storage:Edit** を必ず追加（既存の Pages:Edit と併存）。

3. **Pages の「本番ブランチ」トラップ**
   `./deploy.sh` 初回作成時の対話プロンプト「**production branch name**」に**作業ブランチ名**を入れると、
   deploy.sh は `--branch main` でデプロイするため**全デプロイが preview 扱い**になり、本番URL（`<project>.pages.dev`）に反映されない。
   → **本番ブランチは必ず `main`**（dashboard: Settings → Builds & deployments → Production branch、または API で `production_branch=main` に PATCH）。直したら再デプロイ。
   - 同名が埋まっていると `<project>-xxxx.pages.dev`（今回 `eggcamera-53k.pages.dev`）の**別サブドメイン**が割り当たる。`PAGES_BASE_URL` と CNAME content は**実際の払い出し値**を使う。
   - Pages の環境変数（`R2_PUBLIC_BASE_URL`）は**プロジェクト側に設定**しないと反映されない（→ §5-3）。未設定だと旧バケットへフォールバックして画像404。

4. **R2 CORS は基本不要 / 旧watchdog の誤アラート**
   - フロントは同一オリジンの `/image/<id>` プロキシ（[functions/image/[id].js](EggCameraPages/functions/image/%5Bid%5D.js)）経由でR2を取得し、ブラウザからr2.devへ**直接cross-originアクセスしない**ため `setup-r2-cors.js` は基本不要。
     どうしても適用するならトークンに**バケット設定権限（Admin Read & Write）**が要る（Object R&W だと 403 AccessDenied）。
   - `WATCHDOG_URL` を新Workerへ向けた瞬間、**旧Worker はビートが途絶え約15分で誤「ダウン」Slack通知を出す**（旧にも SLACK secret が残るため）。新Worker疎通を確認したら**旧Workerは速やかに削除/停止**（→ §6-6・§8-4）。

---

## 1. 移行対象リソース（5系統）と、値が反映される場所

| # | 系統 | 実体（旧アカウント） | 跨ぎ移行の扱い | 値の反映先 |
|---|---|---|---|---|
| 1 | **R2** 写真保管 | バケット `eggcamera-photos` / 公開 `pub-c35d182b845942f3b26d0ed65d668e0d.r2.dev` | バケットは移動不可→新規作成。データはドレイン | `EggCameraNode/.env`: `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` `R2_PUBLIC_BASE_URL` |
| 2 | **Pages** DLページ | プロジェクト `eggcamera` / `eggcamera.pages.dev` | 移管不可→再作成＋再デプロイ＋独自ドメイン | `~/EggCamera/.env.cloudflare`: `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID` ／ Pages環境変数 `R2_PUBLIC_BASE_URL` ／ `EggCameraNode/.env`: `PAGES_BASE_URL` |
| 3 | **Workers** 死活監視 | `eggcamera-watchdog` + KV `WATCHDOG`(id `37c18b3baca349178e03e532fe3533d6`) + Cron `*/5` | 再デプロイ＋KV作り直し＋secret再投入 | `EggCameraWatchdog/wrangler.toml`: KV `id` ／ `~/EggCamera/.env.watchdog` と Slackbotの env: `WATCHDOG_URL` |
| 4 | **Tunnel + WARP** 遠隔SSH | `EggCamera-familiar` / CIDR `10.99.99.1/32` | → [CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) §2/§3 | `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` 内token |
| 5 | **独自ドメイン** | （新規） | ゾーン移管せず外部DNSにCNAME | 外部DNSに1レコード ／ `PAGES_BASE_URL` |

> ⚠ 旧アカウントの各種token/シークレット/APIキーは新アカウントでは無効。**すべて新規発行**になる。リポジトリ・チャット・スクショに残さない（env ファイルとパスワードマネージャのみ）。

---

## 2. 事前準備（旧アカウント側の値を控える / リポジトリ側の退避）

1. 旧 env を退避（戻せるように）:
   - `~/EggCamera/.env.cloudflare` `~/EggCamera/EggCameraNode/.env` `~/EggCamera/.env.watchdog`
   - これらは git 管理外。`EggCameraNode/tools/backup.js` のバックアップ対象でもある。
2. 旧アカウントで控える（移行中の照合用）:
   - 現 `PAGES_BASE_URL`（= `https://eggcamera.pages.dev`）と現 R2 `pub-…r2.dev`
   - Pagesプロジェクト名 `eggcamera` / Worker名 `eggcamera-watchdog`
3. **DEPLOY-MARKER を投稿**（毎時テスト監視の誤検知防止）。env差し替え・node再起動の前後で必ず。

---

## 3. 移行先アカウントの初期セットアップ

1. 取引先メールで新Cloudflareアカウント作成（または既存）。
2. **支払い方法（クレジットカード）登録** — Manage Account → Billing → Payment Info。
3. **メンバー招待** — Manage Account → Members → Invite → `creative-center@jizaie.co.jp` を **Administrator**（請求も持つなら Super Administrator）。詳細は [CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) §5。
4. 通知設定（Notifications）を必要分だけ再登録（旧設定は引き継がれない）。

---

## 4. R2 を作り直す

1. R2 → **Create bucket** → 名前 `eggcamera-photos`（同名でよい）。
2. **API token 発行**: R2 → Manage R2 API Tokens → Create（権限 **Object Read & Write**、対象バケット限定推奨）
   → `Access Key ID` / `Secret Access Key` / アカウントID を控える。
3. **公開URL有効化**: バケット → Settings → Public access → r2.dev を有効化 → 新しい `pub-xxxx.r2.dev` を控える。
   > この公開URLは Pages Function とサーバ側だけが叩く**内部用**で、利用者には出ない（QRはPages独自ドメインを指す）。よって R2 側に独自ドメインは付けなくてよい。`r2.dev` は dev用・レート制限ありだが、サーバ間アクセスなので許容。
4. **CORS は基本不要**（→ §0.5-4）。フロントは同一オリジン `/image/<id>` プロキシ経由でR2を直接叩かないため。
   どうしても適用する場合のみ `node EggCameraNode/setup-r2-cors.js`（[setup-r2-cors.js](EggCameraNode/setup-r2-cors.js)。`.env` を新値に）。
   その際トークンは **Admin Read & Write**（バケット設定権限）が必要（Object R&W だと 403 AccessDenied）。
5. 反映: `EggCameraNode/.env` の
   `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME=eggcamera-photos` / `R2_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev`。

---

## 5. Pages を作り直す ＋ 独自ドメイン

1. `~/EggCamera/.env.cloudflare` を新アカウントの値に:
   `CLOUDFLARE_API_TOKEN=<Pages編集権限のトークン>` / `CLOUDFLARE_ACCOUNT_ID=<新アカウントID>`。
   （API token は My Profile → API Tokens、または Account → API Tokens で **Pages:Edit** 権限。）
2. **初回デプロイ**: `cd EggCameraPages && ./deploy.sh`（[deploy.sh](EggCameraPages/deploy.sh)）。
   プロジェクト `eggcamera` が新アカウントに新規作成される。
   - ⚠ 対話の「**production branch name**」は必ず **`main`** にする（deploy.sh が `--branch main` のため）。
     作業ブランチ名を入れると全デプロイが preview 扱いになり本番URLに出ない（→ §0.5-3）。
     誤った場合は dashboard（Settings → Builds & deployments → Production branch）か API で `production_branch=main` に直して再デプロイ。
   - 同名が埋まっていると `eggcamera-xxxx.pages.dev`（今回 `eggcamera-53k.pages.dev`）の別サブドメインになる。以降の `PAGES_BASE_URL` と CNAME content はこの実値を使う。
3. **Pages環境変数**: Pages → 該当プロジェクト → Settings → Environment variables →
   `R2_PUBLIC_BASE_URL = https://pub-xxxx.r2.dev`（**Production と Preview の両方**）。
   未設定だと [functions/image/[id].js](EggCameraPages/functions/image/%5Bid%5D.js#L3) の旧フォールバック値を見てしまうので必ず設定。
4. **独自ドメイン付与**（手順厳守 — 逆順だと522）:
   1. Pages → 該当プロジェクト → **Custom domains → Set up a custom domain** → `photo.例.com` を入力。
   2. その後、**取引先の外部DNS**に次を追加:
      - Type `CNAME` / Name `photo`（= `photo.例.com`）/ Content `eggcamera.pages.dev`
   3. 外部DNSに **CAAレコードがあれば** Cloudflare の発行を許可（`0 issue "letsencrypt.org"` 等に加え、必要なら `pki.goog` / Cloudflareの指示するCA）。無ければ不要。
   4. Cloudflareが証明書を自動発行 → ステータスが **Active** になるまで待つ（数分〜）。
5. 反映: `EggCameraNode/.env` の `PAGES_BASE_URL=https://photo.例.com`。
   → これが [composite.js:131](EggCameraNode/src/composite.js#L131) で **QRの実URL**になる（アカウント非依存になり、将来の移行は無停止化）。

---

## 6. Workers（watchdog）を作り直す

> ⚠ 以下の wrangler は**新アカウントを対象**にする。各コマンド前に必ず
> `set -a; source ~/EggCamera/.env.cloudflare; set +a` で env を注入すること（→ §0.5-1）。
> トークンには **Workers Scripts:Edit + Workers KV Storage:Edit** が必要（→ §0.5-2）。cwd=`EggCameraWatchdog`。

1. **KV作成**: `npx wrangler kv namespace create WATCHDOG`
   → 払い出された `id` を [wrangler.toml](EggCameraWatchdog/wrangler.toml) の `[[kv_namespaces]] id` に貼り替え（旧 `37c18…` を置換）。
   （「already exists」が出たら**旧アカウントを見ている**サイン → env注入を確認）。
2. **デプロイ**: `npx wrangler deploy` → 新 `https://eggcamera-watchdog.<新サブドメイン>.workers.dev` が払い出される。
3. **secret投入**（**デプロイ後**。secret put はスクリプト存在が前提）:
   `npx wrangler secret put BEAT_SECRET` / `npx wrangler secret put SLACK_WEBHOOK_URL`
   （API直叩きでも可。`BEAT_SECRET` は heartbeat 送信側＝`~/EggCamera/.env.watchdog` と同値にする）。
4. 反映:
   - `~/EggCamera/.env.watchdog` の `WATCHDOG_URL=` を新URLに（`BEAT_SECRET` も §6-2と同値に）。
   - Slackbot 側 env（`WATCHDOG_URL`）も同じ新URLに。
5. 確認: `~/EggCamera/EggCameraWatchdog/heartbeat.sh` を1回実行 → `curl -s <新URL> | jq` で `ageSec` が小さい値で返ればOK。
6. 旧watchdogは**新Worker疎通確認後すみやかに削除/停止**する。`WATCHDOG_URL` を新へ向けた時点で
   旧はビートが途絶え**約15分で誤「ダウン」Slack通知**を出すため（→ §0.5-4）。
   削除は**旧アカウント**対象なので env を `unset` し `wrangler whoami` が旧であることを確認してから
   `npx wrangler delete`（または dashboard で Delete）。

---

## 7. Tunnel + WARP（遠隔SSH）

[CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) **§2（クラウド側を新アカウントで作り直す）→ §2.1（token取得）→ §3（Mac mini側のtoken差し替え＋WARP再ログイン）** に従う。
ローカルの SSH / ファイアウォール / ループバック `10.99.99.1` は変更不要。**ドメイン無しでも CIDR `10.99.99.1/32` だけで動く**ので、§5の独自ドメインとは独立。

---

## 8. カットオーバー順序

独自ドメインを使うので**新規発行ぶんは無停止**。ただし**既に配ったQRは旧 `eggcamera.pages.dev`（旧アカウント）を指している**ため、旧アカウントを24〜48h並走させて枯らす（=ドレイン方式）。

1. §3〜§7 を**先に全部用意**（旧アカウントは生かしたまま）。
2. `photo.例.com` の SSL が **Active** になったことを確認（ブラウザで `https://photo.例.com/download/?id=test` が開ける）。
3. **DEPLOY-MARKER 投稿** → `EggCameraNode/.env` を新値に差し替え（`R2_*` / `R2_PUBLIC_BASE_URL` / `PAGES_BASE_URL`）→ node再起動
   `launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`。
   - この瞬間から**新規QRが `photo.例.com`**（新Pages→新R2）を指す。
4. `~/EggCamera/.env.watchdog` の `WATCHDOG_URL` 差し替え → heartbeat即送 → 新watchdog正常確認 → **旧watchdogを削除/停止**（誤アラート防止 → §6-6）。
5. Tunnel token差し替え（§7）。SSH断が一瞬入るので**遠隔作業の合間に**。
6. **24〜48h並走**（旧QRのドレイン）。旧R2写真は24hで自動消滅。**DEPLOY-MARKER 投稿**で完了を記録。
7. ドレイン満了後、旧アカウントの Pages / R2 / Worker / Tunnel を削除 → 課金停止 → **支払い方法削除**。

---

## 9. 反映が必要な設定値 総まとめ

> 新欄は 2026-06-23 時点の **as-built**（実際にデプロイ済の値）。✅=反映済 / ⏳=未実施。

| 値 | 旧（参考） | 新（実値・2026-06-23） | 反映先ファイル |
|---|---|---|---|
| `R2_ACCOUNT_ID` | `ba88e6f860d610fe196e610ac6f99e90` | `e6037dd3898fac341ca130b80faded3c` ✅ | `EggCameraNode/.env` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 旧 | 新R2トークン（設定済 ✅・値は秘匿） | `EggCameraNode/.env` |
| `R2_BUCKET_NAME` | `eggcamera-photos` | `eggcamera-photos`（同名）✅ | `EggCameraNode/.env` |
| `R2_PUBLIC_BASE_URL` | `https://pub-c35d…r2.dev` | `https://pub-94ba5595a94f43218182ab46368c5e40.r2.dev` ✅ | `EggCameraNode/.env` ＋ **Pages環境変数(prod/preview)** |
| `PAGES_BASE_URL` | `https://eggcamera.pages.dev` | `https://eggcamera-53k.pages.dev`（暫定 ✅）／独自ドメイン `photo.例.com` は ⏳ | `EggCameraNode/.env` |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 旧 | `e6037…`（設定済 ✅・トークンに Pages+Workers+KV 権限） | `~/EggCamera/.env.cloudflare` |
| KV `id` | `37c18b3baca349178e03e532fe3533d6` | `a07739df6a104a4bab4a75bb93bdcf64` ✅ | `EggCameraWatchdog/wrangler.toml` |
| `WATCHDOG_URL` | `…siggaze-0000.workers.dev` | `https://eggcamera-watchdog.tanigawa-mn.workers.dev` ✅ | `~/EggCamera/.env.watchdog` ＋ Slackbot env |
| `BEAT_SECRET` / `SLACK_WEBHOOK_URL` | 旧 | 新Workerへ secret 投入済 ✅ | Worker secret ＋ `.env.watchdog` / `.env.slack` |
| cloudflared token | 旧 | ⏳ 未（Tunnel/WARP は未移行） | `com.cloudflare.cloudflared.plist` |

---

## 10. 切り替え後チェックリスト

- [ ] 実機1サイクル: 撮影→QRが `photo.例.com/download?id=…` を指す → ページで写真表示 → 保存できる
- [ ] 新R2にアップロードされる／24hで自動消滅する（`node EggCameraNode/tools/check-r2-cost.js`）
- [ ] watchdog: `ageSec` 正常 ／ ハートビート途絶→Slack ALERT→回復通知が動く
- [ ] Tunnel: cloudflaredログに `Registered tunnel connection`（新アカウント側）／ Termius `eggcamera@10.99.99.1:22` 成功
- [ ] 旧アカウント: 24〜48h後に Pages/R2/Worker/Tunnel 削除・課金停止・**支払い方法削除**
- [ ] 自分が新アカウントの Administrator として参加済み（[CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) §5）
- [ ] 前後で **DEPLOY-MARKER 投稿**済み（監視の誤検知防止）

---

## 11. ロールバック

新値に問題が出たら `EggCameraNode/.env` を**退避した旧値に戻して** `launchctl kickstart -k gui/$(id -u)/com.eggcamera.node`。
旧アカウント一式を§8-7まで生かしてあるので即時復帰できる。`.env.watchdog` / cloudflared plist も同様に旧値へ。

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| [CLOUDFLARE-HANDOVER.md](CLOUDFLARE-HANDOVER.md) | Tunnel/WARP のアカウント切替（§2/§3）＋メンバー招待（§5） |
| [EggCameraPages/deploy.sh](EggCameraPages/deploy.sh) | Pages デプロイ |
| [EggCameraPages/functions/image/[id].js](EggCameraPages/functions/image/%5Bid%5D.js) | R2プロキシ（`R2_PUBLIC_BASE_URL`） |
| [EggCameraWatchdog/wrangler.toml](EggCameraWatchdog/wrangler.toml) | watchdog Worker＋KV id |
| [EggCameraNode/setup-r2-cors.js](EggCameraNode/setup-r2-cors.js) | R2 CORS適用 |
| [EggCameraNode/.env.example](EggCameraNode/.env.example) | env の単一ドキュメント |
