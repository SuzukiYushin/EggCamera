#!/bin/zsh
# Mac miniに会場非依存の固定IP 10.99.99.1 を loopback(lo0) に付与する。
# Cloudflare Tunnel の Private Network 経由で、この固定IPでSSH/VNCに到達できる。
# 会場のLAN IP(192.168.x.x)が変わってもこのIPは不変。
/sbin/ifconfig lo0 alias 10.99.99.1 255.255.255.255 2>/dev/null || true
