#!/usr/bin/env bash
# Smoke test: collab websocket multi-document subscribe and unsubscribe behavior.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

run_probe() {
  local test_case="$1"
  local label="$2"
  local doc_a="$3"
  local expect_a="$4"
  local doc_b="${5:-}"
  local expect_b="${6:-}"
  local doc_c="${7:-}"
  local expect_c="${8:-}"
  local doc_d="${9:-}"
  local expect_d="${10:-}"

  (
    cd "$ROOT_DIR/backend"
    GOWORK=off GOCACHE="$(pwd)/.gocache" go run "$ROOT_DIR/tests/smoke/collab/multi-doc/probe.go" \
      --project-url "$BASE_URL/ws/projects/$PROJECT_ID" \
      --origin "$WS_ORIGIN" \
      --token "$TOKEN" \
      --test "$test_case" \
      --doc-a "$doc_a" \
      --expect-a "$expect_a" \
      --doc-b "$doc_b" \
      --expect-b "$expect_b" \
      --doc-c "$doc_c" \
      --expect-c "$expect_c" \
      --doc-d "$doc_d" \
      --expect-d "$expect_d"
  )
  echo "[smoke] PASS: $label"
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/multi-doc/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

RUN_ID="$(date +%s)"

echo "[smoke] creating temporary project/documents for multi-doc websocket checks..."
create_temp_project "multi-doc-smoke-$RUN_ID"

EXPECT_A="multi-doc-a-$RUN_ID"
create_temp_document "$PROJECT_ID" "tmp-multi-doc-a" "$EXPECT_A"
DOC_A="$DOC_ID"

EXPECT_B="multi-doc-b-$RUN_ID"
create_temp_document "$PROJECT_ID" "tmp-multi-doc-b" "$EXPECT_B"
DOC_B="$DOC_ID"

EXPECT_C="multi-doc-c-$RUN_ID"
create_temp_document "$PROJECT_ID" "tmp-multi-doc-c" "$EXPECT_C"
DOC_C="$DOC_ID"

EXPECT_D="multi-doc-d-$RUN_ID"
create_temp_document "$PROJECT_ID" "tmp-multi-doc-d" "$EXPECT_D"
DOC_D="$DOC_ID"

echo "[smoke] probing multi-document websocket routing..."
run_probe "multi-subscribe" \
  "three documents sync independently on one socket" \
  "$DOC_A" "$EXPECT_A" \
  "$DOC_B" "$EXPECT_B" \
  "$DOC_C" "$EXPECT_C"
run_probe "unsubscribe" \
  "unsubscribe returns NOT_SUBSCRIBED for later binary traffic and keeps socket alive" \
  "$DOC_D" "$EXPECT_D" \
  "" "" \
  "" "" \
  "$DOC_B" "$EXPECT_B"
run_probe "rapid-sub-unsub" \
  "rapid subscribe/unsubscribe/resubscribe converges to a clean final subscription" \
  "$DOC_C" "$EXPECT_C"
run_probe "unsubscribe-nonexistent" \
  "unsubscribe for a never-subscribed doc is handled safely" \
  "$DOC_B" "$EXPECT_B"

echo "[smoke] all multi-document websocket smoke checks passed."
