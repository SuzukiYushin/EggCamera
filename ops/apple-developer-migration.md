# 有料 Apple Developer Program 移行手順（署名7日失効の根絶）

作成: 2026-07-04。Claude Code 無しの本番運用の前提条件その2（その1は Swift フォーマット固定・対応済）。

## なぜ必要か

現在は **無料署名（Personal Team `4U78CNU7WN` / siggaze.0000@gmail.com）** で運用しており、
プロビジョニングプロファイルが **7日で失効** する。過去の「再起動後に復旧しない」障害の最大原因:

- 2026-06-24: 週次refreshがヘッドレス `No Accounts` で失効を防げず本番カメラ停止
- 2026-07-02: Apple ID 再追加で Personal Team ID 自体が変わり（6FKKW68VQ4→4U78CNU7WN）iPhone/iPad 共倒れ
- 失効の度に **実機で開発元の「信頼」タップが必要**（遠隔不可・人依存）

有料 Developer Program（年間 ¥12,980 前後 / 個人）に移行すると:

- プロファイル有効期間が **7日 → 1年**（失効イベントが年1回の計画作業になる）
- 週次 refresh（com.eggcamera.iphone-refresh）への依存がなくなる
- 「信頼」タップは初回インストール時のみ

## 移行手順

### 1. 加入（人間の作業・審査1〜2営業日）

1. https://developer.apple.com/programs/enroll/ から加入。
   - **個人（Individual）**: 早い。Apple ID = siggaze.0000@gmail.com のまま加入すれば
     既存の証明書・bundle ID (`com.siggaze.eggcamera`) と連続性があり移行が最小。
   - 法人（Organization, jizaie.co.jp）: D-U-N-S 番号が必要で日数がかかる。急がないならこちらでも可
     （その場合は bundle ID の所属チームが変わるため下記 3 のチームID更新が必須）。
2. 支払い完了 → 承認メールを待つ。**承認まで従来の週次 refresh 運用を継続**（次回失効目安: 加入前最後の refresh + 7日）。

### 2. Xcode でチーム確認（Mac mini・GUI）

1. Xcode → Settings → Accounts → 対象 Apple ID を選択。
2. チーム一覧に「(Individual)」または会社名のチームが増えている。**そのチームID（10桁英数）を控える**。

### 3. チームIDの反映（2ファイル）

```
EggCameraIPhone/iphone.sh:25   DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-新チームID}"
ops/ipad/resign-all.sh:17      TEAM="新チームID"
```

### 4. 再署名と確認

```
cd ~/EggCamera/EggCameraIPhone && ./iphone.sh refresh   # プロファイル焼き直し(1年有効)＋install＋launch
# 初回のみ: iPhone実機で 設定→一般→VPNとデバイス管理→開発元を「信頼」
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/frame   # 200 を確認
zsh ~/EggCamera/ops/ipad/resign-all.sh                  # WDA(iPadテスト)側の再ビルド
```

その後、毎時テスト1枠（またはtools/ipad-test.js手動1回）の完走を確認。

### 5. 後片付け（任意）

- 週次 refresh `com.eggcamera.iphone-refresh` は失効防止としては不要になる。
  ただし無害（プロファイルの前倒し更新になるだけ）なので **残しておくのが安全**。
  外す場合: `launchctl bootout gui/$(id -u)/com.eggcamera.iphone-refresh` + plist リネーム。
- プロファイル失効は年1回。**失効月の前月にカレンダー登録**しておくこと
  （health-watch は失効そのものを事前検知できない。失効すると毎時テスト連続失敗として現れる）。

## 注意

- **同一 Apple ID で加入する限り、アプリの再インストールや設定変更は不要**（チームIDの差し替えと refresh だけ）。
- 別 Apple ID / 法人で加入する場合は、証明書・プロファイルが全て新規になるため、
  上記 3→4 に加えて iPad 側 WDA の初回 xcodebuild が長くなる（初回のみ）。
- 加入完了までは 7日失効の時限が生きている。**加入を後回しにする場合は週次 refresh の Slack 通知
  （iphone-signing-auto-refresh）を必ず監視すること。**
