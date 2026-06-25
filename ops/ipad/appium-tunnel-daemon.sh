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

# ── 起動前に既存の tunnel-creation を一掃する（孤児の重複防止）──
# `launchctl kickstart -k` は本ジョブの主プロセスしか殺さず、過去に exec した
# `appium driver run xcuitest tunnel-creation` / `tunnel-creation.mjs` の子が
# ppid=1 の孤児として残り、複数が同一デバイスの RemoteXPC トンネルを取り合って
# `RemoteXPC connection timed out` / `port 8100 refused` を誘発する（2026-06-23 実障害）。
# 本スクリプトは root(launchd) 実行なので root 所有の孤児も掃除できる。自分自身は
# パターンに一致しない（zsh が daemon スクリプトを実行しているだけ）ので除外不要。
pkill -9 -f 'xcuitest tunnel-creation' 2>/dev/null || true
pkill -9 -f 'tunnel-creation\.mjs'     2>/dev/null || true
sleep 2  # :42314 とトンネルの解放を待つ

# --disconnect-retry-max-attempts 0 = 切断時に無制限で自動再接続（常駐の堅牢性）
exec /opt/homebrew/bin/appium driver run xcuitest tunnel-creation --disconnect-retry-max-attempts 0
