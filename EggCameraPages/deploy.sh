#!/bin/zsh
# EggCameraPages を Cloudflare Pages へ wrangler で直接デプロイする。
#
# 事前準備（初回のみ）:
#   ~/EggCamera/.env.cloudflare に以下を記載（git管理外）
#     CLOUDFLARE_API_TOKEN=<Pages編集権限のAPIトークン>
#     CLOUDFLARE_ACCOUNT_ID=<アカウントID>
#
# 使い方:
#   ./deploy.sh          # 本番(main)としてデプロイ
#   ./deploy.sh preview  # プレビューとしてデプロイ
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="$HOME/EggCamera/.env.cloudflare"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE がありません。CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID を記載してください" >&2
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

BRANCH="main"
if [[ "${1:-}" == "preview" ]]; then
  BRANCH="wrangler-preview"
fi

npx -y wrangler pages deploy . \
  --project-name eggcamera \
  --branch "$BRANCH" \
  --commit-dirty=true
