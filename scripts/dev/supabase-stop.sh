#!/usr/bin/env bash
# Stop local Supabase containers.
# Data is preserved in Docker volumes — restart with supabase-start.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$REPO_ROOT/backend"
supabase stop

echo ""
echo "Local Supabase stopped."
echo "Data is preserved in Docker volumes."
echo "To also remove data: cd backend && supabase stop --no-backup"
