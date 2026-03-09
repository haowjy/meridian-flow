#!/usr/bin/env bash
# Smoke test: WebSocket collab proposal transport and error paths.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

run_probe() {
  local test_case="$1"
  local label="$2"

  (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/proposals/probe.go" \
      --project-url "$BASE_URL/ws/projects/$PROJECT_ID" \
      --doc-id "$DOC_ID" \
      --origin "$WS_ORIGIN" \
      --token "$TOKEN" \
      --test "$test_case"
  )
  echo "[smoke] PASS: $label"
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/proposals/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary project/document for proposal transport checks..."
create_temp_project "proposal-smoke-$(date +%s)"
create_temp_document "$PROJECT_ID" "tmp-ws-proposal-smoke" ""

echo "[smoke] probing proposal subscribe and error paths..."
run_probe "empty-snapshot" "subscribe returns empty proposal snapshot"
run_probe "accept-not-found" "proposal:accept missing proposal is rejected"
run_probe "reject-not-found" "proposal:reject missing proposal is rejected"
run_probe "accept-not-subscribed" "proposal:accept requires an active subscription"

echo "[smoke] all websocket proposal smoke checks passed."
