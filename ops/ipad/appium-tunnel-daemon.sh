#!/bin/zsh
# Appium公式の RemoteXPC トンネルを root で常駐させる。
# これが iPad/iPhone を Appium(xcuitest) に認識させる唯一の正規手段。
# launchd: com.eggcamera.appium-tunnel（LaunchDaemon, RunAtLoad + KeepAlive）から起動。
#
# 仕組み:
#   `appium driver run xcuitest tunnel-creation` は usbmux 上の各デバイスにトンネルを張り、
#   レジストリサーバ(既定:42314)を立て、そのポートを @appium/strongbox に保存する。
#   Appium本体はそのstrongboxからポートを読みレジストリ経由でデバイスを発見する。
#
# ★HOME 必須: strongbox と ~/.appium はユーザのホーム配下。root(launchd)だと HOME=/var/root に
#   なり Appium(ユーザ実行)が読めず `Tunnel registry port not found` になる。よってユーザを明示。
#   （手動 sudo 実行時は sudoers env_keep+="HOME" で偶然動いていた。launchdには効かない。）
#
# 前提: iPad/iPhone が usbmux に出ていること（`pymobiledevice3 usbmux list` で2台）。
#   Mac再起動後に iPad が usbmux から落ちる場合は USB-C 抜き差しが要る（既知の未解決課題）。
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/eggcamera/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/eggcamera"

echo "$(date '+%F %T') appium tunnel-creation 起動 (uid=$(id -u), HOME=$HOME)"
# --disconnect-retry-max-attempts 0 = 切断時に無制限で自動再接続（常駐の堅牢性）
exec /opt/homebrew/bin/appium driver run xcuitest tunnel-creation --disconnect-retry-max-attempts 0
