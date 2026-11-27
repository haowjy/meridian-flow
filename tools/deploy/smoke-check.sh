#!/usr/bin/env bash
set -euo pipefail


url="${STAGING_URL:-}"
if [[ -z "$url" ]]; then
  echo "::warning title=Smoke check stubbed::STAGING_URL not set; skipping health probe."
  echo "[stub] would: curl --fail \$STAGING_URL/health"
  exit 0
fi

echo "Probing ${url}/health …"
curl --fail --show-error --silent --max-time 30 "${url}/health" >/dev/null
echo "Staging is healthy."
