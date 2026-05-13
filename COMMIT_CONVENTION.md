# Commit Convention

## Format

```
<type>(<scope>): <subject>
```

## Types

| type | 用途 |
|---|---|
| `feat` | 新機能追加 |
| `fix` | バグ修正 |
| `refactor` | 動作変更を伴わない内部整理 |
| `chore` | ビルド・設定・依存関係・gitignore |
| `docs` | ドキュメント |

## Scopes

| scope | 対象 |
|---|---|
| `swift` | EggCameraMac / EggCameraIPhone |
| `node` | EggCameraNode |
| `infra` | ディレクトリ構造・設定ファイル |
| `all` | 複数スコープにまたがる変更 |

## Subject Rules

- 英語・命令形（"add" not "added"）
- 先頭大文字なし・末尾ピリオドなし
- 72文字以内

## Body（任意）

- 変更理由・背景・注意点を記載する
- 日本語可

## Examples

```
feat(swift): add Node.js trigger receiver on port 8082
fix(swift): prevent isSending from sticking after iPhone lock
refactor(node): move composite logic from Swift to Node.js
chore(infra): restructure shared data directory under data/
feat(node): composite flame overlay using sharp and sips
```
