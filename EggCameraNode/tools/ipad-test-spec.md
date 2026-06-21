# iPad Safari EggCamera フルフロー検証仕様

## Phase 1: セッション開始 & adminBusy確認
1. `start_session` capsOverride: `{"appium:usePrebuiltWDA":true,"appium:derivedDataPath":"/Users/eggcamera/Library/Developer/Xcode/DerivedData/WebDriverAgent-dopylywrbtefnbfmomfcvcirfvqt","appium:newCommandTimeout":300}`
2. `navigate` → `http://192.168.10.104:3000/`
3. `execute_script` → `return localStorage.getItem('eggcamera-admin-busy');`
   - null以外 → `end_session` して「管理操作中のためスキップ (adminBusy=<値>)」で終了

## Phase 2: フォトブースフルフロー
4. `tap xpath` → `//button[text()="日本語"]`
5. `tap xpath` → `//button[text()="はじめる"]`
6. `tap xpath` → `//button[text()="スキップ"]` × 2（名前・生年月日）
7. `execute_script` → `const b=document.querySelector('button'); if(b) b.click(); return b?.textContent.trim();`
8. `execute_script` → ボタン一覧確認: `Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).join('|')`
   - `決定` が含まれるまで最大30秒（5秒×6回）リトライ
   - タイムアウト → Slack通知 + `end_session` + 「撮影タイムアウト」報告で終了
9. `tap xpath` → `//button[text()="決定"]`
10. `tap xpath` → `//button[text()="この写真を保存する"]`
11. `execute_script` → `return document.body.innerText.includes('6 / 7') ? 'QR画面OK' : document.body.innerText.slice(0,80);`

## Phase 3: QR画面待機（3分固定）→ 7/7ページ → TOP戻る
12. `Bash` → `sleep 185`（QR表示は3分固定。余裕5秒込み）
13. `execute_script` → `return document.body.innerText.includes('はじめに戻る') ? 'Thanks画面OK' : document.body.innerText.slice(0,60);`
    - `Thanks画面OK` なら → `tap xpath` → `//button[text()="はじめに戻る"]`
    - セッション切れなら再接続してスキップ

## Phase 4: DL検証 & test-report（Bash一括）
```bash
ADMIN_TOKEN=$(grep ADMIN_TOKEN EggCameraNode/.env | cut -d= -f2)
QR_ID=$(curl -s "http://localhost:3001/api/admin/logs?lines=5" -H "X-Admin-Token: $ADMIN_TOKEN" | python3 -c "import sys,json; lines=[d for d in json.load(sys.stdin) if 'QR generated' in d['text']]; print(lines[-1]['text'].split('id=')[-1].strip()) if lines else print('')")
DL_RESULT=$(curl -sL -o /dev/null -w "%{http_code} %{size_download}" "https://eggcamera.pages.dev/image/${QR_ID}.jpg")
HTTP_CODE=$(echo $DL_RESULT | cut -d' ' -f1); DL_SIZE=$(echo $DL_RESULT | cut -d' ' -f2)
HDD=$(curl -s "http://localhost:3001/api/admin/disk" -H "X-Admin-Token: $ADMIN_TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"freeBytes\"]//1024//1024//1024}GB')")
COMPOSITE="familia_${QR_ID#*familia_}.jpg"
if [ "$HTTP_CODE" = "200" ] && [ "$DL_SIZE" -gt 100000 ]; then
  curl -s -X POST http://localhost:3000/api/test-report -H "Content-Type: application/json" -d "{\"level\":\"info\",\"text\":\"[iPad-TEST] フルフロー完了 composite=${COMPOSITE} DL=${DL_SIZE}bytes HDD空き=${HDD}\"}"
else
  curl -s -X POST http://localhost:3000/api/test-report -H "Content-Type: application/json" -d "{\"level\":\"alert\",\"text\":\"▲ [iPad-TEST] DL失敗 HTTP=${HTTP_CODE} SIZE=${DL_SIZE}\"}"
  curl -s -X POST http://localhost:3001/api/admin/notify -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d "{\"text\":\"▲ iPad Safari テスト DL失敗: HTTP=${HTTP_CODE} SIZE=${DL_SIZE}\",\"kind\":\"alert\"}"
fi
echo "HTTP=$HTTP_CODE DL_SIZE=$DL_SIZE HDD=$HDD COMPOSITE=$COMPOSITE"
```

## Phase 5: セッション終了
- `end_session`

## 報告形式
- 正常: `iPad Safari フルフロー完了 (composite: <ファイル名>, DL: <KB>kB, HDD: <N>GB空き)`
- 異常: 詳細 + Slack通知済みを明記
