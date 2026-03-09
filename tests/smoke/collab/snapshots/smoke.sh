#!/usr/bin/env bash
# Smoke test: snapshot REST CRUD + restore flow.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT_DIR/tests/smoke/helpers.sh"

ORIGINAL_CONTENT="snapshot smoke content"
UPDATED_CONTENT="updated content"
SNAPSHOT_NAME="smoke-test-snap"

json_string() {
  local key="$1"
  local file="$2"
  tr -d '\n' <"$file" | sed -n "s/.*\"$key\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

json_int() {
  local key="$1"
  local file="$2"
  tr -d '\n' <"$file" | sed -n "s/.*\"$key\":\\([0-9][0-9]*\\).*/\\1/p" | head -n 1
}

fail_with_body() {
  local label="$1"
  local body_file="$2"
  echo "[smoke] FAIL: $label"
  echo "[smoke] body:"
  cat "$body_file"
  echo
  exit 1
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

assert_nonempty() {
  local value="$1"
  local label="$2"
  if [ -z "$value" ]; then
    echo "[smoke] FAIL: $label"
    exit 1
  fi
  echo "[smoke] PASS: $label"
}

assert_int_ge() {
  local actual="$1"
  local minimum="$2"
  local label="$3"
  if ! [[ "$actual" =~ ^[0-9]+$ ]]; then
    echo "[smoke] FAIL: $label expected integer >= $minimum, got '$actual'"
    exit 1
  fi
  if [ "$actual" -lt "$minimum" ]; then
    echo "[smoke] FAIL: $label expected >= $minimum, got $actual"
    exit 1
  fi
  echo "[smoke] PASS: $label"
}

assert_file_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$file"; then
    fail_with_body "$label" "$file"
  fi
  echo "[smoke] PASS: $label"
}

assert_file_not_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    fail_with_body "$label" "$file"
  fi
  echo "[smoke] PASS: $label"
}

update_document_content() {
  local content="$1"
  local body="{\"content\":\"$content\"}"
  local patch_body="$TMP_DIR/document-update-patch.json"
  local put_body="$TMP_DIR/document-update-put.json"
  local patch_status
  local put_status

  # The current server route is PATCH, but the task brief still calls this PUT.
  patch_status="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$patch_body" \
    -X PATCH \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "$body")"
  if [ "$patch_status" = "200" ]; then
    echo "[smoke] PASS: PATCH /api/documents/{id} updates content (200)"
    return 0
  fi

  put_status="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$put_body" \
    -X PUT \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "$body")"
  if [ "$put_status" != "200" ]; then
    echo "[smoke] FAIL: document update expected 200 from PATCH or PUT, got PATCH=$patch_status PUT=$put_status"
    echo "[smoke] PATCH body:"
    cat "$patch_body"
    echo
    echo "[smoke] PUT body:"
    cat "$put_body"
    echo
    exit 1
  fi

  echo "[smoke] PASS: PUT /api/documents/{id} updates content (200)"
}

fetch_document() {
  local body_file="$1"
  local status
  status="$(status_code "$BASE_URL/api/documents/$DOC_ID" "$body_file" \
    -H "Authorization: Bearer $TOKEN")"
  assert_status "200" "$status" "$body_file" "GET /api/documents/{id}"
}

echo "[smoke] checking backend health..."
HEALTH_BODY="$TMP_DIR/health.json"
if ! HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")"; then
  echo "[smoke] FAIL: could not connect to $BASE_URL"
  echo "[smoke] start the backend server, then rerun:"
  echo "         bash tests/smoke/collab/snapshots/smoke.sh"
  exit 1
fi
assert_status "200" "$HEALTH_STATUS" "$HEALTH_BODY" "GET /health"

echo "[smoke] creating temporary project/document for snapshot flow..."
create_temp_project "snapshot-smoke-$(date +%s)"
create_temp_document "$PROJECT_ID" "tmp-snapshot-smoke" "$ORIGINAL_CONTENT"

DOC_BODY="$TMP_DIR/document-get-initial.json"
fetch_document "$DOC_BODY"
DOC_CONTENT="$(json_string "content" "$DOC_BODY")"
assert_eq "$ORIGINAL_CONTENT" "$DOC_CONTENT" "document starts with known content"

echo "[smoke] creating named snapshot..."
CREATE_BODY="$TMP_DIR/snapshot-create.json"
CREATE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots" "$CREATE_BODY" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"$SNAPSHOT_NAME\"}")"
assert_status "201" "$CREATE_STATUS" "$CREATE_BODY" "POST /api/documents/{id}/snapshots"

SNAPSHOT_ID="$(json_string "id" "$CREATE_BODY")"
assert_nonempty "$SNAPSHOT_ID" "snapshot id parsed from create response"
assert_eq "$SNAPSHOT_NAME" "$(json_string "name" "$CREATE_BODY")" "snapshot create response includes name"

echo "[smoke] listing snapshots after create..."
LIST_BODY="$TMP_DIR/snapshot-list.json"
LIST_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots?limit=50&offset=0" "$LIST_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$LIST_STATUS" "$LIST_BODY" "GET /api/documents/{id}/snapshots"
assert_file_contains "\"id\":\"$SNAPSHOT_ID\"" "$LIST_BODY" "snapshot list includes created snapshot"
LIST_TOTAL="$(json_int "total" "$LIST_BODY")"
assert_int_ge "$LIST_TOTAL" "1" "snapshot list total is at least 1"

echo "[smoke] fetching snapshot content..."
CONTENT_BODY="$TMP_DIR/snapshot-content.json"
CONTENT_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots/$SNAPSHOT_ID/content" "$CONTENT_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$CONTENT_STATUS" "$CONTENT_BODY" "GET /api/documents/{id}/snapshots/{sid}/content"
assert_eq "$ORIGINAL_CONTENT" "$(json_string "content" "$CONTENT_BODY")" "snapshot content matches original document content"

echo "[smoke] updating document content..."
update_document_content "$UPDATED_CONTENT"
DOC_UPDATED_BODY="$TMP_DIR/document-get-updated.json"
fetch_document "$DOC_UPDATED_BODY"
UPDATED_DOC_CONTENT="$(json_string "content" "$DOC_UPDATED_BODY")"
assert_eq "$UPDATED_CONTENT" "$UPDATED_DOC_CONTENT" "document content updates via REST"

echo "[smoke] restoring from snapshot..."
RESTORE_BODY="$TMP_DIR/snapshot-restore.json"
RESTORE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots/$SNAPSHOT_ID/restore" "$RESTORE_BODY" \
  -X POST \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$RESTORE_STATUS" "$RESTORE_BODY" "POST /api/documents/{id}/snapshots/{sid}/restore"
assert_eq "restored" "$(json_string "status" "$RESTORE_BODY")" "restore response status is restored"

DOC_RESTORED_BODY="$TMP_DIR/document-get-restored.json"
fetch_document "$DOC_RESTORED_BODY"
RESTORED_DOC_CONTENT="$(json_string "content" "$DOC_RESTORED_BODY")"
assert_eq "$ORIGINAL_CONTENT" "$RESTORED_DOC_CONTENT" "document content is restored to snapshot content"

echo "[smoke] listing snapshots before delete..."
PRE_DELETE_BODY="$TMP_DIR/snapshot-list-pre-delete.json"
PRE_DELETE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots?limit=50&offset=0" "$PRE_DELETE_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$PRE_DELETE_STATUS" "$PRE_DELETE_BODY" "GET /api/documents/{id}/snapshots before delete"
PRE_DELETE_TOTAL="$(json_int "total" "$PRE_DELETE_BODY")"
assert_int_ge "$PRE_DELETE_TOTAL" "1" "snapshot total before delete is at least 1"

echo "[smoke] deleting snapshot..."
DELETE_BODY="$TMP_DIR/snapshot-delete.json"
DELETE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots/$SNAPSHOT_ID" "$DELETE_BODY" \
  -X DELETE \
  -H "Authorization: Bearer $TOKEN")"
assert_status "204" "$DELETE_STATUS" "$DELETE_BODY" "DELETE /api/documents/{id}/snapshots/{sid}"

echo "[smoke] listing snapshots after delete..."
POST_DELETE_BODY="$TMP_DIR/snapshot-list-post-delete.json"
POST_DELETE_STATUS="$(status_code "$BASE_URL/api/documents/$DOC_ID/snapshots?limit=50&offset=0" "$POST_DELETE_BODY" \
  -H "Authorization: Bearer $TOKEN")"
assert_status "200" "$POST_DELETE_STATUS" "$POST_DELETE_BODY" "GET /api/documents/{id}/snapshots after delete"
assert_file_not_contains "\"id\":\"$SNAPSHOT_ID\"" "$POST_DELETE_BODY" "deleted snapshot no longer appears in list"
POST_DELETE_TOTAL="$(json_int "total" "$POST_DELETE_BODY")"
assert_int_ge "$POST_DELETE_TOTAL" "0" "snapshot total after delete is valid"
if [[ "$PRE_DELETE_TOTAL" =~ ^[0-9]+$ ]] && [[ "$POST_DELETE_TOTAL" =~ ^[0-9]+$ ]]; then
  if [ "$POST_DELETE_TOTAL" -ge "$PRE_DELETE_TOTAL" ]; then
    echo "[smoke] FAIL: snapshot total should decrease after delete (before=$PRE_DELETE_TOTAL after=$POST_DELETE_TOTAL)"
    exit 1
  fi
  echo "[smoke] PASS: snapshot total decreases after delete"
fi

echo "[smoke] all snapshot REST smoke checks passed."
