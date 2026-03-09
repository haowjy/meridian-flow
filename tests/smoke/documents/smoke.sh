#!/usr/bin/env bash
# Smoke test: Documents REST API CRUD flow.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

DOC_NAME="tmp-document-smoke-$(date +%s)"
UPDATED_DOC_NAME="${DOC_NAME}-updated"
DOC_CONTENT="document-smoke-content-$(date +%s)"
UPDATED_DOC_CONTENT="${DOC_CONTENT}-updated"

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/documents/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary project for document ownership..."
create_temp_project "documents-smoke-$(date +%s)"

CREATE_BODY="$TMP_DIR/document-create.json"
CREATE_STATUS="$(status_code "$BASE_URL/api/documents" "$CREATE_BODY" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"project_id\":\"$PROJECT_ID\",\"name\":\"$DOC_NAME\",\"extension\":\".md\",\"content\":\"$DOC_CONTENT\"}")"
assert_status "201" "$CREATE_STATUS" "$CREATE_BODY" "POST /api/documents"

DOC_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$CREATE_BODY" | head -n 1)"
if [ -z "$DOC_ID" ]; then
  echo "[smoke] FAIL: could not parse document id"
  cat "$CREATE_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: parsed document id"

GET_BODY="$TMP_DIR/document-get.json"
GET_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$GET_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$GET_STATUS" "$GET_BODY" "GET /api/documents/{id}"
GET_CONTENT="$(sed -n 's/.*"content":"\([^"]*\)".*/\1/p' "$GET_BODY" | head -n 1)"
if [ "$GET_CONTENT" != "$DOC_CONTENT" ]; then
  echo "[smoke] FAIL: expected document content '$DOC_CONTENT', got '$GET_CONTENT'"
  cat "$GET_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: fetched document content matches"

UPDATE_BODY="$TMP_DIR/document-update.json"
UPDATE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$UPDATE_BODY" \
  -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"$UPDATED_DOC_NAME\",\"content\":\"$UPDATED_DOC_CONTENT\"}")"
assert_status "200" "$UPDATE_STATUS" "$UPDATE_BODY" "PATCH /api/documents/{id}"

GET_UPDATED_BODY="$TMP_DIR/document-get-updated.json"
GET_UPDATED_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$GET_UPDATED_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$GET_UPDATED_STATUS" "$GET_UPDATED_BODY" "GET /api/documents/{id} after update"
UPDATED_CONTENT="$(sed -n 's/.*"content":"\([^"]*\)".*/\1/p' "$GET_UPDATED_BODY" | head -n 1)"
if [ "$UPDATED_CONTENT" != "$UPDATED_DOC_CONTENT" ]; then
  echo "[smoke] FAIL: expected updated document content '$UPDATED_DOC_CONTENT', got '$UPDATED_CONTENT'"
  cat "$GET_UPDATED_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: updated document content matches"

LIST_BODY="$TMP_DIR/project-tree.json"
# The backend exposes project-scoped document listing through the tree endpoint.
LIST_STATUS="$(status_code "$BASE_URL/api/projects/$PROJECT_ID/tree" "$LIST_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$LIST_STATUS" "$LIST_BODY" "GET /api/projects/{id}/tree"
if ! grep -q "\"id\":\"$DOC_ID\"" "$LIST_BODY"; then
  echo "[smoke] FAIL: created document id not found in project tree"
  cat "$LIST_BODY"
  echo
  exit 1
fi
echo "[smoke] PASS: document appears in project tree"

DELETE_BODY="$TMP_DIR/document-delete.json"
DELETE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$DELETE_BODY" \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN")"
assert_status "204" "$DELETE_STATUS" "$DELETE_BODY" "DELETE /api/documents/{id}"

DELETED_GET_BODY="$TMP_DIR/document-get-deleted.json"
DELETED_GET_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$DELETED_GET_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "404" "$DELETED_GET_STATUS" "$DELETED_GET_BODY" "GET /api/documents/{id} after delete"

echo "[smoke] documents REST smoke checks passed."
