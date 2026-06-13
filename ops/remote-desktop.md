# リモートデスクトップ（Cloudflare Tunnel・ドメイン不要 / WARPプライベートネット）

会場のMac mini に **SSH と 画面共有(VNC)** で外から確実に入るための最終手段。
公開ホスト名やドメインは使わず、Cloudflare の **WARP + Tunnel のプライベートネットワーク**で接続する。
NAT/ファイアウォール内でもアウトバウンド接続のみで成立する。

**構成のキモ**：Mac mini に会場非依存の固定IP `10.99.99.1`（loopbackエイリアス）を振り、
そのIPを Tunnel のプライベートネットワークで通す。会場のLAN IPが変わっても接続先IPは不変。

```
[手元PC] --WARP--> Cloudflare --Tunnel--> [Mac mini] 10.99.99.1 :22(SSH) / :5900(VNC)
```

---

## 1. Mac mini 側の準備（このリポジトリで完了済みの物＋sudoコマンド）

### 1-1. 固定IP（loopbackエイリアス）を起動時に付与（sudo・一度だけ）
```bash
sudo cp ~/EggCamera/ops/cloudflared/com.eggcamera.loopback.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.eggcamera.loopback.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.eggcamera.loopback.plist
# 即時付与＆確認
sudo ~/EggCamera/ops/cloudflared/loopback-alias.sh
ifconfig lo0 | grep 10.99.99.1   # 表示されればOK
```

### 1-2. SSH（リモートログイン）と 画面共有 を有効化（sudo）
```bash
# SSH
sudo systemsetup -setremotelogin on
# 画面共有(VNC)
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -restart -agent -privs -all
# VNCパスワード（VNCクライアント用。8文字まで有効）
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -configure -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw 'お好きなPW'
```

### 1-3. cloudflared（インストール済み）をトンネル接続として常駐
Zero Trust ダッシュボードでトンネルを作成（下の 2-2）すると
`cloudflared service install eyJ…(token)…` というコマンドが表示されるので、それを実行:
```bash
sudo cloudflared service install eyJ……（ダッシュボードからコピー）
```
→ cloudflared が system デーモンとして常駐し、起動時も自動接続する。

---

## 2. Cloudflare 側（Zero Trust ダッシュボード）

> 仮アカウントでも可。アカウント移行時はトンネルを作り直すだけ（数分）。

### 2-1. Zero Trust を有効化
ダッシュボード → **Zero Trust** → チーム名を決めて開始（無料プラン）。

### 2-2. トンネル作成
**Networks → Tunnels → Create a tunnel** → **Cloudflared** → 名前 `eggcamera-ops` →
表示される `cloudflared service install …` を Mac mini で実行（1-3）。「Connected」になればOK。
※ Public Hostname は設定しない（プライベートネット方式のため）。

### 2-3. プライベートネットワークのルート追加
作成したトンネル → **Private Network** タブ → **Add a private network** →
CIDR に `10.99.99.1/32` を登録。

### 2-4. WARP を有効化＆デバイス登録
**Settings → WARP Client** で有効化。手元PC/スマホに **Cloudflare WARP** を入れ、
`Login to Cloudflare Zero Trust` で同じチームにログイン。
**Settings → WARP Client → Device settings → Split Tunnels** で `10.99.99.1/32` が
ルーティング対象に含まれるようにする（Exclude モードなら除外リストから外す/Include で追加）。

### 2-5.（推奨）Access で認証をかける
SSHは鍵認証で守られるが、VNCは弱いので **Access → Applications** で
`10.99.99.1` 宛をメール/Googleログイン必須にしておくとより安全。

---

## 3. 手元PCからの接続

WARP を ON にした状態で:

```bash
# SSH（端末作業・Botの補完。Mac mini上で何でもできる）
ssh eggcamera@10.99.99.1

# 画面共有(VNC) — macOSなら Finder → 移動 → サーバへ接続
open vnc://10.99.99.1
# または「画面共有.app」で 10.99.99.1 を開く
```

---

## 4. 位置づけ

- 普段の運用は Slack Bot（`/egg …`）で完結。これは**Botで対処できない事態の最終手段**。
- SSHが入れれば Bot が落ちていても何でもできる（launchctl/再起動/ログ調査）。
- VNCはGUIをそのまま見たい時（iPadやキオスク画面の確認、ダイアログ対応など）。

## 5. アカウント移行時

仮Cloudflareアカウントから本番アカウントへ移る際は、本リモートデスクトップは
**2-1〜2-4 をやり直すだけ**（Mac mini側 1-1/1-2/固定IPはそのまま）。所要数分。
