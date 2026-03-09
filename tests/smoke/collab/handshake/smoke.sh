#!/usr/bin/env bash
# Smoke test: WebSocket collab handshake -- auth gates + sync handshake.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

# ---- helper: probe websocket handshake -----------------------------------

probe_ws() {
  local project_url="$1"
  local doc_id="$2"
  local tok="$3"
  local expected="$4"
  local label="$5"

  (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/handshake/probe.go" \
      --project-url "$project_url" \
      --doc-id "$doc_id" \
      --origin "$WS_ORIGIN" \
      --token "$tok" \
      --expect "$expected"
  )
  echo "[smoke] PASS: $label ($expected)"
}

# ---- health check --------------------------------------------------------

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/handshake/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

# ---- create temp project + document --------------------------------------

echo "[smoke] creating temporary project/document for ownership checks..."
create_temp_project "collab-smoke-$(date +%s)"
create_temp_document "$PROJECT_ID" "tmp-ws-collab-smoke" "smoke"

# ---- websocket probes ----------------------------------------------------

echo "[smoke] probing websocket auth and access gates..."
probe_ws "$BASE_URL/ws/projects/$PROJECT_ID" "$DOC_ID" "not-a-real-token" "AUTH_FAILED" "JWT rejected"
probe_ws "$BASE_URL/ws/projects/$PROJECT_ID" "00000000-0000-0000-0000-000000000123" "$TOKEN" "FORBIDDEN" "unknown document forbidden"
probe_ws "$BASE_URL/ws/projects/$PROJECT_ID" "$DOC_ID" "$TOKEN" "SYNC_OK" "owner path completes sync handshake"

echo "[smoke] all websocket handshake smoke checks passed."
