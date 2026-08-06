#!/bin/zsh
# フォワーダ(127.0.0.1:18100 → iPad:8100)を見張り、落ちていたら起動し直す常駐ループ。
#
# なぜ launchd ではなく tmux/ターミナルで動かすのか:
#   フォワーダは iPad へ LAN 接続するため macOS のローカルネットワーク権限(TCC)が必要。
#   launchd から起動したプロセスにはこの権限が無く、起動しても iPad へ繋げないため、
#   毎時テストの自動復旧は必ず失敗する（2026-07-28〜30 は実際にこれで2日以上、
#   実機ハーネスが API 代替へフォールバックし続けた）。対話シェルから起動した
#   プロセスは権限を引き継ぐので、ここで面倒を見る。
#
# 【重要】起動元のシェルが権限を持っているかで結果が変わる:
#   権限が無いシェルから起動すると、フォワーダは 18100 を LISTEN するのに iPad へ
#   繋げず、curl は 000（空応答）を返す。プロセスは生きているので「動いているのに
#   繋がらない」という分かりにくい壊れ方をする。実測（2026-07-30）:
#     - tmux セッション eggcamera 内 … 権限なし → 復旧NG
#     - Claude Code / ターミナルのシェル … 権限あり → 復旧OK
#   起動後に必ず `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18100/status`
#   で 200 を確認すること（プロセスの生存確認だけでは不十分）。
#
# 使い方（権限のあるシェルから）:
#   nohup ops/ipad/wda-forwarder-keepalive.sh > /dev/null 2>&1 &
# 単発の復旧だけなら ops/ipad/wda-wifi-recovery.sh を直接実行すればよい。
set -u

IPAD_IP="192.168.11.104"
FWD_PORT=18100
INTERVAL=60          # 監視間隔(秒)
LOG="$HOME/Library/Logs/eggcamera-wda-forwarder-keepalive.log"
FWD="/Users/eggcamera/EggCamera/ops/ipad/wda-forwarder.js"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 二重起動を防ぐ。複数走ると互いにフォワーダを再起動し合って落ち着かない。
SELF=$$
others=$(pgrep -f "wda-forwarder-keepalive.sh" | grep -v "^${SELF}$" | grep -v "^$PPID$" || true)
if [ -n "$others" ]; then
  log "既に keepalive が動作中(PID: $(echo $others | tr '\n' ' ')) → 起動を中止"
  exit 0
fi

log "keepalive 開始 (${INTERVAL}秒間隔・127.0.0.1:${FWD_PORT} → ${IPAD_IP}:8100)"

while true; do
  if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:${FWD_PORT}/status"; then
    if curl -s -m 5 -o /dev/null "http://${IPAD_IP}:8100/status"; then
      log "フォワーダ停止を検知 → 起動し直す"
      # パターンは必ず .js まで書く。"wda-forwarder" だけだと自分自身
      # (wda-forwarder-keepalive.sh) にも一致して自滅する（2026-07-30に実際に発生）。
      pkill -f "wda-forwarder\\.js" 2>/dev/null
      sleep 1
      nohup node "$FWD" > "$HOME/Library/Logs/eggcamera-wda-forwarder.log" 2>&1 &
      sleep 3
      if curl -s -m 5 -o /dev/null "http://127.0.0.1:${FWD_PORT}/status"; then
        log "復旧OK"
      else
        # LISTEN はしているのに応答が無い＝起動元シェルにローカルネットワーク権限が無い。
        # この状態はいくら再起動しても直らないので、繰り返し警告を出して人へ渡す。
        log "復旧NG: プロセスは起動したが iPad へ到達できない。起動元シェルにローカル"
        log "        ネットワーク権限が無い（tmux 内などで起動していないか確認）。"
        log "        ターミナル/Claude Code のシェルから起動し直すこと。"
      fi
    else
      # iPad 自体が不通ならフォワーダを上げても意味がない。ここでは待つだけにして、
      # 通知は毎時テスト側（切り分けメッセージを出す）に任せる。
      log "iPad本体が不通のため待機（直接 ${IPAD_IP}:8100 も無応答）"
    fi
  fi
  sleep "$INTERVAL"
done
