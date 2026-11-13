#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "::warning title=Staging migrations stubbed::STAGING_DATABASE_URL not configured; printing plan only."
  echo "[stub] pnpm --filter @meridian/database db:migrate"
  exit 0
fi

echo "Applying Meridian Flow app-schema migrations…"
pnpm --filter @meridian/database db:migrate
