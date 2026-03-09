#!/usr/bin/env bash
# Smoke test: WebSocket collab sync roundtrip -- append via Yjs, reconnect, verify persistence.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

# ---- health check --------------------------------------------------------

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/sync/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

# ---- create temp project + document --------------------------------------

echo "[smoke] creating temporary project/document for sync roundtrip..."
create_temp_project "roundtrip-$(date +%s)"
create_temp_document "$PROJECT_ID" "tmp-ws-roundtrip" ""

EXPECTED_TEXT="sync-roundtrip-$(date +%s)"

# ---- websocket sync probe ------------------------------------------------

echo "[smoke] running websocket sync probe (append + reconnect verify)..."
(
  cd "$ROOT_DIR/backend"
  GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/sync/probe.go" \
    --project-url "$BASE_URL/ws/projects/$PROJECT_ID" \
    --doc-id "$DOC_ID" \
    --origin "$WS_ORIGIN" \
    --token "$TOKEN" \
    --append "$EXPECTED_TEXT" \
    --expect "$EXPECTED_TEXT" \
    --verify-reconnect
)

# ---- verify persistence via REST -----------------------------------------

echo "[smoke] waiting for debounce persistence..."
sleep 3

GET_DOC_BODY="$TMP_DIR/get_doc.json"
GET_DOC_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$GET_DOC_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$GET_DOC_STATUS" "$GET_DOC_BODY" "GET /api/documents/{id}"
ACTUAL_TEXT="$(sed -n 's/.*"content":"\([^"]*\)".*/\1/p' "$GET_DOC_BODY" | head -n 1)"
if [ "$ACTUAL_TEXT" != "$EXPECTED_TEXT" ]; then
  echo "[smoke] FAIL: expected persisted content '$EXPECTED_TEXT', got '$ACTUAL_TEXT'"
  cat "$GET_DOC_BODY"
  echo
  exit 1
fi

echo "[smoke] PASS: persisted content matches expected update"
echo "[smoke] websocket sync roundtrip checks passed."
