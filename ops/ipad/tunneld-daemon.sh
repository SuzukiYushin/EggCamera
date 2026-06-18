#!/bin/zsh
# RemoteXPC tunneld を root で常駐させる（無線 iPad / iOS17+ 用）。
# launchd: com.eggcamera.tunneld（LaunchDaemon, RunAtLoad + KeepAlive）から起動。
#
# なぜ必要か:
#   無線(WiFi)接続の iPad は usbmux 経路に居ないため、Appium(xcuitest) は
#   RemoteXPC トンネル(tunneld のレジストリ :49151)を経由してデバイスを発見する。
#   tunneld が落ちていると Appium は `Tunnel registry port not found` → usbmux に
#   フォールバックし、USB の iPhone しか見えず iPad が `Unknown device UDID` になる。
#   Mac 再起動後にこれが未起動だと iPad テストが一切開始できない（ops gap の恒久対策）。
#
# root 必須: tunneld は utun インターフェースを作成するため。
set -u
export PATH="/Users/eggcamera/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PMD="/Users/eggcamera/.local/bin/pymobiledevice3"

if [ ! -x "$PMD" ]; then
  echo "$(date '+%F %T') FATAL: pymobiledevice3 が見つからない: $PMD" >&2
  exit 1
fi

echo "$(date '+%F %T') tunneld 起動: $PMD remote tunneld (uid=$(id -u))"
# レジストリは既定で 127.0.0.1:49151。Appium はここを参照する。
exec "$PMD" remote tunneld
