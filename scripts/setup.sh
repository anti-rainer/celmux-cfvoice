#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "需要 Node.js 22 或更高版本和 npm。" >&2
  exit 1
fi

npm ci
npx wrangler whoami >/dev/null 2>&1 || {
  echo "尚未登录 Cloudflare，正在打开登录流程…"
  npx wrangler login
}

# Build and validate before touching secrets so a broken change fails fast.
npm run typecheck
npx wrangler deploy --dry-run

# `secret list` prints names only; values are never read back. Existing
# secrets are reused so a redeploy does not force re-entering them.
existing=$(npx wrangler secret list 2>/dev/null || true)
for name in CELMUX_AGENT_TOKEN CLOUDFLARE_SFU_APP_ID CLOUDFLARE_SFU_API_TOKEN; do
  if printf '%s' "$existing" | grep -q "$name"; then
    echo "Secret $name 已存在，跳过。"
  else
    echo "设置 Secret $name（输入不会显示）："
    npx wrangler secret put "$name"
  fi
done

npm run deploy
echo "部署完成。请先在 Cloudflare 控制台绑定自定义域名，再将该 HTTPS 地址和 CELMUX_AGENT_TOKEN 填入 Celmux。"
