#!/usr/bin/env bash
# Smoke test: Projects REST API CRUD flow.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

PROJECT_NAME="tmp-project-smoke-$(date +%s)"
UPDATED_PROJECT_NAME="${PROJECT_NAME}-updated"

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/projects/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

CREATE_BODY="$TMP_DIR/project-create.json"
CREATE_STATUS="$(status_code "$BASE_URL/api/projects" "$CREATE_BODY" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"$PROJECT_NAME\"}")"
assert_status "201" "$CREATE_STATUS" "$CREATE_BODY" "POST /api/projects"

PROJECT_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$CREATE_BODY" | head -n 1)"
if [ -z "$PROJECT_ID" ]; then
  echo "[smoke] FAIL: could not parse project id"
  cat "$CREATE_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: parsed project id"

GET_BODY="$TMP_DIR/project-get.json"
GET_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID" "$GET_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$GET_STATUS" "$GET_BODY" "GET /api/projects/{id}"
GET_NAME="$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$GET_BODY" | head -n 1)"
if [ "$GET_NAME" != "$PROJECT_NAME" ]; then
  echo "[smoke] FAIL: expected project name '$PROJECT_NAME', got '$GET_NAME'"
  cat "$GET_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: fetched project name matches"

UPDATE_BODY="$TMP_DIR/project-update.json"
UPDATE_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID" "$UPDATE_BODY" \
  -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"$UPDATED_PROJECT_NAME\"}")"
assert_status "200" "$UPDATE_STATUS" "$UPDATE_BODY" "PATCH /api/projects/{id}"

GET_UPDATED_BODY="$TMP_DIR/project-get-updated.json"
GET_UPDATED_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID" "$GET_UPDATED_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$GET_UPDATED_STATUS" "$GET_UPDATED_BODY" "GET /api/projects/{id} after update"
UPDATED_NAME="$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$GET_UPDATED_BODY" | head -n 1)"
if [ "$UPDATED_NAME" != "$UPDATED_PROJECT_NAME" ]; then
  echo "[smoke] FAIL: expected updated project name '$UPDATED_PROJECT_NAME', got '$UPDATED_NAME'"
  cat "$GET_UPDATED_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: updated project name matches"

LIST_BODY="$TMP_DIR/project-list.json"
LIST_STATUS="$(status_code "$BASE_URL/api/projects" "$LIST_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$LIST_STATUS" "$LIST_BODY" "GET /api/projects"
if ! grep -q "\"id\":\"$PROJECT_ID\"" "$LIST_BODY"; then
  echo "[smoke] FAIL: created project id not found in project list"
  cat "$LIST_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: project appears in list response"

DELETE_BODY="$TMP_DIR/project-delete.json"
# Current handler returns the deleted project JSON with 200, not 204.
DELETE_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID" "$DELETE_BODY" \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$DELETE_STATUS" "$DELETE_BODY" "DELETE /api/projects/{id}"

DELETED_GET_BODY="$TMP_DIR/project-get-deleted.json"
DELETED_GET_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID" "$DELETED_GET_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "404" "$DELETED_GET_STATUS" "$DELETED_GET_BODY" "GET /api/projects/{id} after delete"

PROJECT_ID=""
echo "[smoke] projects REST smoke checks passed."
