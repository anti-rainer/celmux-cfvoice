#!/usr/bin/env bash
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "需要 Node.js 18+ 和 npm。" >&2
  exit 1
fi

npm install
npx wrangler whoami >/dev/null 2>&1 || {
  echo "尚未登录 Cloudflare，正在打开登录流程…"
  npx wrangler login
}

echo "依次输入 Secret。输入不会显示，也不会写入仓库。"
for name in CELMUX_AGENT_TOKEN CLOUDFLARE_REALTIME_APP_ID CLOUDFLARE_REALTIME_API_TOKEN; do
  npx wrangler secret put "$name"
done

npm run deploy
echo "部署完成。请将输出的 workers.dev HTTPS 地址和 CELMUX_AGENT_TOKEN 填入 Celmux。"
