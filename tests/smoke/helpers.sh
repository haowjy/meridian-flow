#!/usr/bin/env bash
# Shared helpers for collab smoke tests.
# Source this file from individual smoke.sh scripts after setting ROOT_DIR.
#
# Provides:
#   - .env loading
#   - BASE_URL, WS_ORIGIN, TOKEN variables
#   - status_code()   -- curl wrapper returning HTTP status
#   - assert_status()  -- assert HTTP status matches expected
#   - create_temp_project() -- creates a project, sets PROJECT_ID
#   - create_temp_document() -- creates a document, sets DOC_ID
#   - cleanup trap (deletes temp dir + project)

set -euo pipefail

# ---- env / config --------------------------------------------------------

if [ -z "${ROOT_DIR:-}" ]; then
  echo "[smoke] BUG: ROOT_DIR must be set before sourcing helpers.sh"
  exit 1
fi

cd "$ROOT_DIR"

# Load worktree-aware port config (same as run.sh)
# shellcheck disable=SC1091
source scripts/dev/lib.sh 2>/dev/null || true

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BASE_URL="${BASE_URL:-http://localhost:${BACKEND_PORT:-8080}}"
WS_ORIGIN="${WS_ORIGIN:-http://localhost:3000}"
TOKEN="${ACCESS_TOKEN:-${AUTH_TOKEN:-${MERIDIAN_ACCESS_TOKEN:-${TOKEN:-}}}}"

if [ -z "$TOKEN" ]; then
  echo "[smoke] missing token. Set ACCESS_TOKEN (or AUTH_TOKEN/MERIDIAN_ACCESS_TOKEN/TOKEN) in .env."
  exit 1
fi

# ---- temp dir + cleanup --------------------------------------------------

TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "${PROJECT_ID:-}" ]; then
    curl -sS -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/api/projects/$PROJECT_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

# ---- HTTP helpers ---------------------------------------------------------

status_code() {
  local url="$1"
  local out="$2"
  shift 2
  curl -sS -o "$out" -w "%{http_code}" "$@" "$url"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local body_file="$3"
  local label="$4"
  if [ "$actual" != "$expected" ]; then
    echo "[smoke] FAIL: $label expected $expected, got $actual"
    echo "[smoke] body:"
    cat "$body_file"
    echo
    exit 1
  fi
  echo "[smoke] PASS: $label ($actual)"
}

# ---- resource creation helpers -------------------------------------------

# create_temp_project [name_suffix]
# Sets PROJECT_ID on success.
create_temp_project() {
  local suffix="${1:-smoke-$(date +%s)}"
  local body_file="$TMP_DIR/project.json"

  local status
  status="$(status_code "$BASE_URL/api/projects" "$body_file" \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"tmp-ws-$suffix\"}")"
  assert_status "201" "$status" "$body_file" "POST /api/projects"

  PROJECT_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$body_file" | head -n 1)"
  if [ -z "$PROJECT_ID" ]; then
    echo "[smoke] FAIL: could not parse project id"
    cat "$body_file"
    echo
    exit 1
  fi
}

# create_temp_document <project_id> <name> <content>
# Sets DOC_ID on success.
create_temp_document() {
  local project_id="$1"
  local name="$2"
  local content="$3"
  local body_file="$TMP_DIR/document.json"

  local status
  status="$(status_code "$BASE_URL/api/documents" "$body_file" \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"project_id\":\"$project_id\",\"name\":\"$name\",\"extension\":\".md\",\"content\":\"$content\"}")"
  assert_status "201" "$status" "$body_file" "POST /api/documents"

  DOC_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$body_file" | head -n 1)"
  if [ -z "$DOC_ID" ]; then
    echo "[smoke] FAIL: could not parse document id"
    cat "$body_file"
    echo
    exit 1
  fi
}
