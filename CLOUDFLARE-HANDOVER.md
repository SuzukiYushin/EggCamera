# Cloudflare 設定まとめ（アカウント切り替え移行手順書）

最終更新: 2026-06-18 / 現アカウント: `Siggaze.0000@gmail.com`

iPhone から Mac mini へ遠隔 SSH するための Cloudflare Tunnel + WARP 構成。
**アカウント切り替え時は §2 のクラウド側だけ作り直し、§3 の Mac mini ローカル側はそのまま流用できる。**

---

## 0. 現行アカウント情報（旧アカウント・参考）

| 項目 | 値 |
|---|---|
| アカウントメール | Siggaze.0000@gmail.com |
| アカウントID | `ba88e6f860d610fe196e610ac6f99e90` |
| ドメイン | `siggaze.com` |
| トンネル名 | `EggCamera-familiar` |
| トンネルID | `a8af1972-e932-43ca-a008-a5a38ae11685` |
| コネクタホスト | `EggCameranoMac-mini.local` |
| 固定到達IP | `10.99.99.1`（lo0 ループバックエイリアス） |
| SSHユーザー | `eggcamera` |
| cloudflared | 2026.6.0（Homebrew） |

> ⚠ トンネルtoken/シークレットは新アカウントでは無効。新規トンネル作成で新tokenが発行される。tokenはリポジトリに書かない（`com.cloudflare.cloudflared.plist` 内のみ）。

---

## 1. これまでの設定（時系列）

### 旧アカウントで実施済み（〜2026-06-13）
1. **Cloudflareアカウント登録**（Siggaze.0000@gmail.com）
2. **ドメイン追加** `siggaze.com` をCloudflareに登録（ネームサーバ移管）
3. **Zero Trust有効化**（チーム名＝組織名を設定。WARPログインに必須）
   - **クレジットカード（支払い方法）登録** — Zero Trust有効化に伴う請求先設定
   - **通知設定** — Cloudflare側のアラート/通知の有効化
4. **Mac miniに cloudflared インストール**（`brew install cloudflared`）
5. **トンネル `EggCamera-familiar` 作成**（token方式）
6. **launchd常駐化** `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`（token方式・RunAtLoad・KeepAlive）
7. **固定IPループバック付与** `10.99.99.1/32` を lo0 に
   - スクリプト: `ops/cloudflared/loopback-alias.sh`
   - 常駐: `/Library/LaunchDaemons/com.eggcamera.loopback.plist`
   - 目的: 会場LAN IP(192.168.x.x)が変わっても不変の到達先を確保
8. **CIDRルート登録** `10.99.99.1/32` → 仮想ネットワーク`default`（説明: "EggCamera-familiar remote"）
9. **Mac mini SSH有効化**（リモートログインON・パスワード認証）

### 今回追加で実施（2026-06-18）
10. **macOSファイアウォール有効化**
    - `socketfilterfw --add /opt/homebrew/bin/node`
    - `socketfilterfw --unblockapp /opt/homebrew/bin/node`
    - `socketfilterfw --setglobalstate on`
11. **iPhoneアプリ導入**: Cloudflare One（WARP/Zero Trustクライアント）+ Termius（SSHクライアント）
    - ※ 1.1.1.1アプリはZero Trust非対応で不可
12. **WARPでZero Trustログイン**（チーム名入力）→ VPN接続
13. **Termius接続成功** `eggcamera@10.99.99.1:22` パスワード認証
14. **（途中・予備経路）ブラウザSSH** — WARP+Termiusで繋がったため未完了のまま保留
    - ホスト名ルート `ssh.siggaze.com`
    - Accessアプリ "ssh"（SSHブラウザレンダリングON）
    - 公開アプリケーションルート `localhost:22`

---

## 2. 新アカウントで作り直す（クラウド側）★切替時の作業

1. **新Cloudflareアカウント登録 / ログイン**
2. **支払い方法（クレジットカード）登録** — Manage Account → Billing → Payment Info
3. **ドメイン追加**（`siggaze.com` を新アカウントに移すか、新ドメインを使用）
   - 同じドメインを移す場合は旧アカウントから削除 → 新アカウントで追加 → ネームサーバ確認
4. **Zero Trust有効化** → **チーム名（組織名）を決める**（後でWARPログインに使う・メモ必須）
   - Zero Trustプラン選択時にも支払い方法が必要
5. **通知設定** — Notifications で必要なアラートを再登録（旧アカウントの設定は引き継がれない）
6. **トンネル新規作成 ＋ token取得**（→ 詳細は §2.1）
   - Networks → Tunnels → Create tunnel → `cloudflared` 選択
   - 名前: `EggCamera-familiar`（任意）
   - 表示される **install token をコピー**（次の §3-A で使用）
7. **CIDRルート登録**
   - Networks → Routes → CIDRルートを追加
   - ネットワーク: `10.99.99.1/32` / 仮想ネットワーク: `default`
8. **デバイス登録ポリシー確認**（Settings → WARP Client → Device enrollment permissions で自分のメールを許可）
9. （任意・ブラウザSSHも欲しい場合のみ）ホスト名ルート + Accessアプリ + 公開ルート`localhost:22` を §1-14 と同様に再作成

---

## 2.1 token（install token）の取得方法 ★重要

cloudflaredを常駐させる token は **トンネル作成時に1回だけ画面表示** される。
plist に入れる token は、表示コマンド `cloudflared service install eyJ...` の **`eyJ` で始まる長い文字列部分**。

### 作成直後にコピーする場合
1. Create tunnel → 名前入力 → Save
2. 「Install and run a connector」画面が出る → **OS: macOS** を選択
3. 表示されるコマンド例:
   ```
   cloudflared service install eyJhIjoiXXXX...（長い文字列）
   ```
   この **`eyJ...` 部分だけ** をコピー → plistに貼る（§3-A）

### 後からtokenを取り出す場合（コピーし忘れた時）
- Networks → Tunnels → 該当トンネル → **`...`メニュー → Configure** → 同じインストール画面でtoken再表示
- または **Refresh token** で新tokenを再発行（旧tokenは無効化される）

### tokenの中身（参考・base64デコードで判別可能）
`{"a": アカウントID, "t": トンネルID, "s": シークレット}` の3点が入っている。
→ アカウントを間違えると `a`（アカウントID）が変わるので、デコードで確認できる。

> ⚠ tokenはトンネルへのフルアクセス権を持つ秘密情報。**リポジトリ・チャット・スクショに残さない**。plist内とパスワードマネージャのみ。

---

## 3. 新アカウントで差し替える（Mac mini ローカル側）★token入れ替えのみ

ローカルの SSH / ファイアウォール / ループバック(10.99.99.1) は **変更不要**。tokenだけ差し替える。

### A. cloudflared tokenの差し替え
```bash
# 1. 新tokenをCloudflareダッシュボードからコピー
# 2. サービス停止
sudo launchctl bootout system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# 3. plist内の <string>eyJ...（旧token）</string> を新tokenに書き換え
sudo nano /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# 4. サービス再開
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# 5. 接続確認（Registered tunnel connection が出ればOK）
tail -f /Library/Logs/com.cloudflare.cloudflared.out.log
```

### B. iPhone WARP の再ログイン
1. Cloudflare One アプリ → 一度ログアウト
2. **新しいチーム名（組織名）**で再ログイン
3. WARP ON → Termiusで `eggcamera@10.99.99.1` 接続確認

---

## 4. 切り替え後チェックリスト

- [ ] 支払い方法（クレジットカード）登録済み
- [ ] 通知設定 再登録済み
- [ ] cloudflaredログに `Registered tunnel connection`（新アカウント側）
- [ ] ダッシュボードでトンネル ステータス「正常」
- [ ] CIDRルート `10.99.99.1/32` 登録済み
- [ ] iPhone WARP 新チームで接続
- [ ] Termius `eggcamera@10.99.99.1:22` でSSH成功
- [ ] （旧アカウント）旧トンネル削除・課金停止・**支払い方法削除**
- [ ] 自分のアドレスを取引先アカウントにメンバー追加（→ §5）

---

## 5. 取引先アカウントに自分（管理者）を追加する ★メンバー招待

新アカウントは取引先のメールで作成 → **そのアカウントに自分のアドレスをメンバー招待** すれば、
取引先がオーナー、自分が管理者として共同管理できる（パスワード共有不要）。

### 招待手順（取引先＝オーナー側が操作）
1. ダッシュボード右上 → **Manage Account → Members**
2. **Invite** をクリック
3. 自分のメールアドレスを入力
4. **Role: Administrator**（または Super Administrator）を選択
   - Super Administrator: 請求・メンバー管理含む全権
   - Administrator: 請求以外のほぼ全権（トンネル/Zero Trust/DNS操作可）
5. Invite送信 → 自分のメールに届く招待を承認

### Zero Trust（WARP/トンネル）の権限
- 上記でアカウントメンバーになれば Zero Trust ダッシュボードも操作可能
- WARP接続そのものは Zero Trust の **Device enrollment policy** で別管理
  - Settings → WARP Client → Device enrollment permissions に自分のメールを許可
  - → 自分のiPhoneを取引先チームにWARP登録できる

### 役割分担の例
| 担当 | アドレス | Role |
|---|---|---|
| 取引先（オーナー・請求） | 取引先メール | Super Administrator |
| 自分（運用・保守） | creative-center@jizaie.co.jp 等 | Administrator |

> メリット: 取引先が支払い・所有権を持ちつつ、日常の運用・token差し替え・トラブル対応は自分が実施できる。
> 取引先のログイン情報を預からずに済む。

---

## 関連ローカルファイル

| ファイル | 役割 |
|---|---|
| `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` | トンネル常駐（**ここのtokenを差し替え**） |
| `/Library/LaunchDaemons/com.eggcamera.loopback.plist` | 10.99.99.1常駐付与 |
| `ops/cloudflared/loopback-alias.sh` | ループバック付与スクリプト |
| `/Library/Logs/com.cloudflare.cloudflared.{out,err}.log` | トンネルログ |
