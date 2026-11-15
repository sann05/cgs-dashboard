#!/bin/sh
# Publishes static/ plus functions/ (keys.json from the project's secrets) to
# Cloudflare Pages. First time: npx wrangler login, then set the key once:
#   npx wrangler pages secret put ZERION_API_KEY --project-name cgs-dashboard
set -eu
cd "$(dirname "$0")"
npx -y wrangler@4 pages deploy static --project-name "${CGS_PAGES_PROJECT:-cgs-dashboard}" --branch main --commit-dirty=true
