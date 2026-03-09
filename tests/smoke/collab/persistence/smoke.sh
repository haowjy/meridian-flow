#!/usr/bin/env bash
# Smoke test: collab persistence via debounce, disconnect flush, and reconnect round-trip.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

json_string() {
  local key="$1"
  local file="$2"
  tr -d '\n' <"$file" | sed -n "s/.*\"$key\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "[smoke] FAIL: $label expected '$expected', got '$actual'"
    exit 1
  fi
  echo "[smoke] PASS: $label"
}

run_probe() {
  local doc_id="$1"
  local test_name="$2"
  local text="$3"

  (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/persistence/probe.go" \
      --project-url "$BASE_URL/ws/projects/$PROJECT_ID" \
      --doc-id "$doc_id" \
      --origin "$WS_ORIGIN" \
      --token "$TOKEN" \
      --test "$test_name" \
      --text "$text"
  )
}

fetch_document_content() {
  local doc_id="$1"
  local body_file="$2"
  local status

  status="$(status_code "$BASE_URL/api/documents/$doc_id" "$body_file" \
    -H "Authorization: Bearer $TOKEN")"
  assert_status "200" "$status" "$body_file" "GET /api/documents/{id}" >&2
  json_string "content" "$body_file"
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/persistence/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary project for persistence probes..."
create_temp_project "persistence-smoke-$(date +%s)"

DEBOUNCE_TEXT="abcde"
echo "[smoke] creating debounce document..."
create_temp_document "$PROJECT_ID" "tmp-collab-persist-debounce" ""
DEBOUNCE_DOC_ID="$DOC_ID"

echo "[smoke] running debounce persistence probe..."
run_probe "$DEBOUNCE_DOC_ID" "debounce" "$DEBOUNCE_TEXT"

echo "[smoke] waiting for debounce persistence..."
sleep 3

DEBOUNCE_BODY="$TMP_DIR/document-debounce.json"
DEBOUNCE_CONTENT="$(fetch_document_content "$DEBOUNCE_DOC_ID" "$DEBOUNCE_BODY")"
assert_eq "$DEBOUNCE_TEXT" "$DEBOUNCE_CONTENT" "debounce persistence content matches"

DISCONNECT_TEXT="persist-me-$(date +%s)"
echo "[smoke] creating disconnect-flush document..."
create_temp_document "$PROJECT_ID" "tmp-collab-persist-disconnect" ""
DISCONNECT_DOC_ID="$DOC_ID"

echo "[smoke] running disconnect-flush persistence probe..."
run_probe "$DISCONNECT_DOC_ID" "disconnect-flush" "$DISCONNECT_TEXT"

echo "[smoke] waiting for disconnect flush persistence..."
sleep 3

DISCONNECT_BODY="$TMP_DIR/document-disconnect.json"
DISCONNECT_CONTENT="$(fetch_document_content "$DISCONNECT_DOC_ID" "$DISCONNECT_BODY")"
assert_eq "$DISCONNECT_TEXT" "$DISCONNECT_CONTENT" "disconnect flush content matches"

ROUND_TRIP_TEXT="round-trip-$(date +%s)"
echo "[smoke] creating round-trip document..."
create_temp_document "$PROJECT_ID" "tmp-collab-persist-roundtrip" ""
ROUND_TRIP_DOC_ID="$DOC_ID"

echo "[smoke] running round-trip persistence probe..."
run_probe "$ROUND_TRIP_DOC_ID" "round-trip" "$ROUND_TRIP_TEXT"

echo "[smoke] all collab persistence smoke checks passed."
