#!/usr/bin/env bash
# Smoke test: collab websocket resilience to malformed binary envelopes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

run_case() {
  local case_name="$1"
  local initial_content="envelope-${case_name}-$(date +%s)"

  create_temp_document "$PROJECT_ID" "tmp-envelope-${case_name}" "$initial_content"

  if (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/envelope/probe.go" \
      --project-url "$BASE_URL/ws/projects/$PROJECT_ID" \
      --doc-id "$DOC_ID" \
      --origin "$WS_ORIGIN" \
      --token "$TOKEN" \
      --test "$case_name" \
      --expect-text "$initial_content"
  ); then
    echo "[smoke] PASS: $case_name"
    return 0
  fi

  echo "[smoke] FAIL: $case_name"
  exit 1
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/envelope/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary project for envelope fuzzing..."
create_temp_project "envelope-fuzz-$(date +%s)"

echo "[smoke] running malformed envelope probes..."
run_case "truncated"
run_case "wrong-doc-uuid"
run_case "corrupted-yjs"
run_case "unknown-type"
run_case "zero-payload"
run_case "oversized"

echo "[smoke] envelope fuzzing checks passed."
