#!/usr/bin/env bash
# Smoke test orchestrator. Refreshes token, waits for health, runs all probes.
#
# Usage:
#   bash tests/smoke/run.sh                    # all smoke tests
#   bash tests/smoke/run.sh collab             # collab only
#   bash tests/smoke/run.sh collab/handshake   # specific subfeature
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Load port config
source scripts/dev/lib.sh 2>/dev/null || true
BASE_URL="${BASE_URL:-http://localhost:${BACKEND_PORT:-8080}}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
FILTER="${1:-}"

passed=0
failed=0
skipped=0

run_probe() {
  local name="$1"
  local script="$2"

  # Apply filter if provided
  if [[ -n "$FILTER" ]] && [[ "$name" != *"$FILTER"* ]]; then
    skipped=$((skipped + 1))
    return 0
  fi

  echo ""
  echo "[smoke] --- $name ---"
  if bash "$script"; then
    passed=$((passed + 1))
  else
    echo "[smoke] FAIL: $name"
    failed=$((failed + 1))
  fi
}

# --- Prerequisites ---

echo "[smoke] waiting for backend health at $BASE_URL/health..."
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "[smoke] FAIL: backend did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s"
    exit 1
  fi
  sleep 1
done
echo "[smoke] backend is healthy"

echo "[smoke] refreshing access token..."
./scripts/get-token.sh

# --- Smoke Probes ---

# Collab
run_probe "collab/handshake" "tests/smoke/collab/handshake/smoke.sh"
run_probe "collab/sync"      "tests/smoke/collab/sync/smoke.sh"
run_probe "collab/proposals"   "tests/smoke/collab/proposals/smoke.sh"
run_probe "collab/snapshots"   "tests/smoke/collab/snapshots/smoke.sh"
run_probe "collab/persistence" "tests/smoke/collab/persistence/smoke.sh"

# REST features (uncomment as probes are written)
run_probe "documents" "tests/smoke/documents/smoke.sh"
run_probe "projects"  "tests/smoke/projects/smoke.sh"
# run_probe "threads"   "tests/smoke/threads/smoke.sh"
# run_probe "auth"      "tests/smoke/auth/smoke.sh"

# --- Summary ---

echo ""
echo "============================="
echo "[smoke] passed:  $passed"
echo "[smoke] failed:  $failed"
echo "[smoke] skipped: $skipped"
echo "============================="

if (( failed > 0 )); then
  exit 1
fi
