#!/bin/zsh
#
# force-rare-once.sh — 次の撮影1回だけ、指定のレアアイテムを必ず出す（デモ/確認用）。
#
#   使い方: ops/force-rare-once.sh XF      … SP-XF を次の1回だけ強制
#           ops/force-rare-once.sh XB      … SP-XB
#           ops/force-rare-once.sh --undo  … 待たずに今すぐ元へ戻す
#
# 仕組み: growthFrames.json の rare を指定1種だけにし rareProbability を 1.0 にする。
#   src/growthFrames.js の loadMeta() は毎回ファイルを読むので **node の再起動は不要**。
#   合成が1回終わったら（node.out に "QR generated" が増えたら）自動で元に戻す。
#   取りこぼしても 30分で必ず復元し、Ctrl-C や kill でも trap で復元する。
#
set -u
META="/Users/eggcamera/EggCamera/data/assets/frames/growth/growthFrames.json"
BK="/Users/eggcamera/EggCamera/data/assets/frames/growth/.growthFrames.oneshot.bak"
LOG="$HOME/Library/Logs/eggcamera-node.out"
MARK="http://127.0.0.1:3000/api/test-report"

restore() {
  if [[ -f "$BK" ]]; then
    mv -f "$BK" "$META"
    print -r -- "✅ 通常のレア確率へ戻しました"
    curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
      --data '{"level":"info","text":"DEPLOY-MARKER(manual): レア強制ワンショット終了。通常のレア確率(5%・2種)へ復元。"}' >/dev/null 2>&1
  fi
}
trap restore EXIT INT TERM

if [[ "${1:-}" == "--undo" ]]; then restore; exit 0; fi

KEY="${1:-XF}"
[[ -f "$BK" ]] && { print -r -- "⚠ 既に強制中です。先に --undo してください"; trap - EXIT; exit 1; }

cp "$META" "$BK"
LABEL=$(KEY="$KEY" META="$META" python3 - <<'PY'
import json, os
p = os.environ['META']; key = os.environ['KEY']
d = json.load(open(p))
hit = [r for r in d.get('rare', []) if r.get('key') == key]
if not hit:
    print('__NOTFOUND__'); raise SystemExit
d['rare'] = hit
d['rareProbability'] = 1.0          # 月齢に関係なく必ずこの1種が出る
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print(hit[0].get('label') or key)
PY
)
if [[ "$LABEL" == "__NOTFOUND__" ]]; then
  print -r -- "❌ key='$KEY' のレアアイテムがありません"; restore; trap - EXIT; exit 1
fi

print -r -- "🎯 次の撮影1回だけ「$LABEL」を強制します（合成が終わると自動で戻します）"
curl -s -m 8 -X POST "$MARK" -H 'Content-Type: application/json' \
  --data "{\"level\":\"info\",\"text\":\"DEPLOY-MARKER(manual): 次の撮影1回だけレア『${LABEL}』を強制（rareProbability=1.0・当該1種のみ）。完了後に自動復元。\"}" >/dev/null 2>&1

BEFORE=$(grep -c "QR generated" "$LOG" 2>/dev/null || print 0)
for i in {1..360}; do          # 5秒 × 360 = 30分で必ず抜ける
  sleep 5
  NOW=$(grep -c "QR generated" "$LOG" 2>/dev/null || print 0)
  if (( NOW > BEFORE )); then
    print -r -- "📸 撮影1回を検知しました"
    break
  fi
done
# restore は trap EXIT で走る
