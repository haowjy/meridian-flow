#!/usr/bin/env bash
set -euo pipefail

commit="${GITHUB_SHA:-$(git rev-parse HEAD)}"
ref="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

cat <<MSG
── Meridian Flow → staging ─────────────────────────
 commit : ${commit}
 ref    : ${ref}
 build  : apps/server + apps/app + apps/www
────────────────────────────────────────────────────
MSG

# ── SWAP-IN POINT ───────────────────────────────────────────────────────────
echo "::warning title=Staging deploy is a stub::No real staging host wired yet. See tools/deploy/deploy-staging.sh."
echo "[stub] would publish apps/server, apps/app, and apps/www artifacts and run the rollout."
# ────────────────────────────────────────────────────────────────────────────
