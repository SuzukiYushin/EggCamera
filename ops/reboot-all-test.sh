#!/bin/zsh
# 再起動ルーティンの前半: iPhone を再起動し、復帰を確認する。
# 2026-08-06〜 iPadは既定で再起動対象外（疎通確認のみ／REBOOT_IPAD=1 で従来の再起動に戻る）。
# Mac mini は最後に別途 `sudo -n /sbin/shutdown -r now` で（このスクリプトには含めない＝
# 呼び出し側が iPad疎通/iPhone復帰を確認してから最後に撃つ）。
# iPad/iPhone は sudo 不要（Apple devicectl）。
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

IPAD_UDID="00008132-001E2934019A401C"
URL="http://192.168.11.106:3000/"
IPHONE_DIR="/Users/eggcamera/EggCamera/EggCameraIPhone"
IPHONE_FRAME_URL="http://127.0.0.1:8080/frame"
MARK_URL="http://127.0.0.1:3000/api/test-report"

mark() { curl -s -m 8 -X POST "$MARK_URL" -H 'Content-Type: application/json' --data "{\"level\":\"info\",\"text\":\"DEPLOY-MARKER(reboot-test): $1\"}" >/dev/null 2>&1; }

# 進捗表示（2026-08-06追加）。待ちループ中に端末が無反応に見えるのを防ぐ。
# /dev/tty へ直接書くので、呼び出し側で tee にパイプされていても画面に出る。
# 同じ行を上書きするだけなのでログには一切残らない（launchdでは /dev/tty が無く黙って失敗する）。
prog()     { printf '\r\033[K      … %s' "$*" >/dev/tty 2>/dev/null || true; }
prog_end() { printf '\r\033[K' >/dev/tty 2>/dev/null || true; }

echo "==== $(date '+%F %T') 再起動ルーティン前半（iPad疎通→iPhone再起動）開始 ===="
mark "再起動ルーティン開始。iPhone/Mac再起動（iPadは対象外）。一時的な撮影断・無応答は本作業由来で異常ではありません。"

# テスト用Appiumセッションが走っていないこと（RemoteXPC競合回避）。
# 注意: 単純な `pgrep -f ipad-test.js` は post-boot復旧Claudeのプロンプト本文(多行)に
# "ipad-test.js"/"node" が含まれて誤検知する。実際の node …ipad-test.js だけを
# PID単位・claude(dangerously-skip-permissions)除外・自己マッチ回避([i]) で判定する。
running_ipad_test() {
  local pid cmd
  for pid in $(pgrep -f '[i]pad-test\.js' 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null | tr '\n' ' ')
    case "$cmd" in
      (*dangerously-skip-permissions*) continue ;;
      (*node*ipad-test.js*) return 0 ;;
    esac
  done
  return 1
}
if running_ipad_test; then
  echo "⚠ node ipad-test.js 実行中。競合回避のため中止。"; exit 2
fi

# ───── 1) iPad ─────
# 2026-08-06〜 既定でiPadは再起動しない（REBOOT_IPAD=1 で従来動作に戻せる）。
# 理由: 再起動はキオスクを必ず落とすが自動復帰せず、遠隔復旧手段(MCP/Appium/WDA)も撤去済みのため
#       復帰に人の手が要る。週次のMac再起動でiPadまで巻き込む必要はない。
# スキップ時も「iPadが生きているか」だけは確認する（Mac再起動前のゲート判断材料にするため）。
if [ "${REBOOT_IPAD:-0}" = 1 ]; then
  echo "[iPad] WiFi再起動+Safari起動（ipad-wifi-reboot.sh）…"
  if /Users/eggcamera/EggCamera/ops/ipad/ipad-wifi-reboot.sh; then
    ipad_back=1
  else
    ipad_back=0; echo "[iPad] ⚠ ipad-wifi-reboot.sh 失敗/未完了"
  fi
else
  echo "[iPad] 再起動はスキップ（週次対象外・REBOOT_IPAD=1 で有効化）。疎通のみ確認…"
  ipad_back=0
  for i in $(seq 1 12); do
    xcrun devicectl device info details --device "$IPAD_UDID" 2>/dev/null \
      | grep -qiE "tunnelState:[[:space:]]*connected" && { ipad_back=1; break; }
    prog "iPad疎通を確認中 $((i*5))/60秒"
    sleep 5
  done
  prog_end
  [ "$ipad_back" = 1 ] && echo "[iPad] 疎通OK（再起動なし）" || echo "[iPad] ⚠ 疎通確認できず（再起動はしていない）"
fi

# ───── 2) iPhone ─────
# 判定は「ダウン後の200復帰」で行う（2026-08-06修正）。
# 旧実装は (a) iphone.sh の終了ステータスをパイプで捨て、(b) 復帰を frame=200 の単発到達性だけで
# 見ていたため、再起動が失敗して端末が一度も落ちていない場合に「5秒で復帰」と誤合格していた。
# ゲートはMac再起動という不可逆判断の直前にあるので、誤合格は許容しない。
echo "[iPhone] 再起動…（iphone.sh reboot = devicectl・端末復帰とアプリ起動まで待つので数分かかります）"
( cd "$IPHONE_DIR" && ./iphone.sh reboot ) 2>&1 | sed 's/^/[iPhone] /'
reboot_rc=${pipestatus[1]}

iphone_back=0
if [ "$reboot_rc" != 0 ]; then
  # 再起動コマンド自体が失敗＝端末は落ちていない。到達性が200でも「復帰」とは呼ばない。
  echo "[iPhone] ⚠ iphone.sh reboot が失敗 (rc=$reboot_rc) → 再起動されていない。復帰判定はスキップし失敗扱い"
else
  frame_code() { curl -s -o /dev/null -m 5 -w "%{http_code}" "$IPHONE_FRAME_URL" 2>/dev/null || echo 000; }

  # ① ダウン窓の観測（補強証拠。必須条件にはしない）
  #    iphone.sh は --wait-for-device で端末復帰＋アプリ起動まで待ってから戻るため、ここに
  #    来た時点で端末は既に起動済み。ダウン中の瞬間を捕まえられるかはタイミング次第
  #    （2026-08-06の実測では残り5秒だけ観測できた）。これを必須にすると、復帰が速いだけで
  #    「再起動していない」と誤判定し、Mac再起動を不必要に中止してしまう。
  seen_down=0
  for i in $(seq 1 6); do   # 最大30秒だけ覗く
    [ "$(frame_code)" != 200 ] && { prog_end; echo "[iPhone] ダウン窓を観測（$((i*5))秒）= 再起動の実行を裏付け"; seen_down=1; break; }
    prog "ダウン窓を観測中 $((i*5))/30秒（観測できなくても正常）"
    sleep 5
  done
  prog_end
  [ "$seen_down" = 1 ] || echo "[iPhone] ダウン窓は観測できず（iphone.shが復帰まで待つため正常。rcとframeで判定する）"

  # ② 最終的に frame=200 を確認（rc=0 と併せて合否を決める）
  for i in $(seq 1 36); do  # 最大180秒
    c=$(frame_code)
    [ "$c" = 200 ] && { prog_end; echo "[iPhone] frame=200 確認（$((i*5))秒）"; iphone_back=1; break; }
    prog "カメラ復帰を待機中 $((i*5))/180秒  frame=$c"
    sleep 5
  done
  prog_end
  [ "$iphone_back" = 1 ] || echo "[iPhone] ⚠ 180秒経っても frame=200 に戻らず"
fi

# ───── 結果 ─────
echo ""
echo "==== 前半結果: iPad疎通=$ipad_back（再起動なし） / iPhone復帰=$iphone_back ===="
mark "iPad疎通=$ipad_back(再起動なし) iPhone復帰=$iphone_back。"
echo "==== $(date '+%F %T') 前半完了 ===="

# 呼び出し側(weekly-reboot-all.sh)が Mac 再起動の可否を判断できるよう、結果を終了ステータスで返す。
# echo だけだと呼び出し側が独自に到達性を測り直して誤合格する（2026-08-06のバグ）。
if [ "$iphone_back" != 1 ]; then
  echo "（iPhone未復帰のため exit 1 を返す＝呼び出し側はMac再起動を中止すること）"
  exit 1
fi
echo "（この後、呼び出し側が Mac mini を再起動する）"
exit 0
