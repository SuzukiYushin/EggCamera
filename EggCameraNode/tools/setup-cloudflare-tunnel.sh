#!/bin/bash
# Cloudflare Tunnel + SSH セットアップスクリプト
# 実行前に: ドメイン名を DOMAIN 変数に入れてください
# 実行方法: bash EggCameraNode/tools/setup-cloudflare-tunnel.sh

set -e

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
    echo "使い方: bash setup-cloudflare-tunnel.sh あなたのドメイン.com"
    exit 1
fi

TUNNEL_NAME="eggcamera"
CONFIG="$HOME/.cloudflared/config.yml"
PLIST="$HOME/Library/LaunchAgents/com.eggcamera.cloudflared.plist"

echo "=== Step 1: Cloudflare ログイン ==="
cloudflared tunnel login

echo "=== Step 2: トンネル作成 ==="
cloudflared tunnel create "$TUNNEL_NAME"
TUNNEL_ID=$(cloudflared tunnel list --output json | python3 -c "import sys,json; t=[x for x in json.load(sys.stdin) if x['name']=='$TUNNEL_NAME']; print(t[0]['id'])")
echo "Tunnel ID: $TUNNEL_ID"

echo "=== Step 3: DNS 登録 ==="
cloudflared tunnel route dns "$TUNNEL_NAME" "ssh.$DOMAIN"

echo "=== Step 4: config.yml 作成 ==="
mkdir -p ~/.cloudflared
cat > "$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: ssh.$DOMAIN
    service: ssh://localhost:22
  - service: http_status:404
EOF
echo "config.yml 作成完了: $CONFIG"

echo "=== Step 5: SSH 有効化確認 ==="
if ! sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then
    echo "SSH を有効化します..."
    sudo systemsetup -setremotelogin on
fi

echo "=== Step 6: launchd plist 作成 ==="
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.eggcamera.cloudflared</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string><string>$CONFIG</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/eggcamera-cloudflared.out</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/eggcamera-cloudflared.err</string>
</dict>
</plist>
EOF
launchctl load "$PLIST"
echo "launchd 登録完了"

echo ""
echo "=== 完了 ==="
echo "iPhoneのSafariから以下にアクセスしてください："
echo "  https://ssh.$DOMAIN"
echo ""
echo "※ Cloudflareダッシュボードで Access アプリケーションの設定が必要です："
echo "  Zero Trust → Access → Applications → Add → SSH"
echo "  Hostname: ssh.$DOMAIN"
echo "  Browser rendering: Enable SSH browser rendering"
