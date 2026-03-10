#!/usr/bin/env bash
# Smoke test: WebSocket collab security edge cases.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

PROJECT_IDS=()

cleanup_security() {
  local exit_code="$1"
  trap - EXIT

  for project_id in "${PROJECT_IDS[@]}"; do
    if [ -n "$project_id" ]; then
      curl -sS -X DELETE \
        -H "Authorization: Bearer $TOKEN" \
        "$BASE_URL/api/projects/$project_id" >/dev/null || true
    fi
  done

  PROJECT_ID=""
  cleanup
  exit "$exit_code"
}

trap 'cleanup_security $?' EXIT

probe_ws_security() {
  local test_name="$1"
  shift

  (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/security/probe.go" \
      --project-url "$BASE_URL/ws/projects/$PROJECT_A_ID" \
      --doc-id "$DOC_A_ID" \
      --other-doc-id "$DOC_B_ID" \
      --origin "$WS_ORIGIN" \
      --token "$TOKEN" \
      --test "$test_name" \
      "$@"
  )
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/security/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary projects/documents for cross-project checks..."
create_temp_project "collab-security-a-$(date +%s)"
PROJECT_A_ID="$PROJECT_ID"
PROJECT_IDS+=("$PROJECT_A_ID")
create_temp_document "$PROJECT_A_ID" "tmp-collab-security-a" "security-a"
DOC_A_ID="$DOC_ID"

create_temp_project "collab-security-b-$(date +%s)"
PROJECT_B_ID="$PROJECT_ID"
PROJECT_IDS+=("$PROJECT_B_ID")
create_temp_document "$PROJECT_B_ID" "tmp-collab-security-b" "security-b"
DOC_B_ID="$DOC_ID"

echo "[smoke] running websocket security probes..."
probe_ws_security "cswsh-origin"
probe_ws_security "expired-token-subscribe"
probe_ws_security "garbage-token"
probe_ws_security "no-auth-timeout"
probe_ws_security "cross-doc-subscribe"
probe_ws_security "double-subscribe"

echo "[smoke] websocket security smoke checks completed."
