#!/usr/bin/env bash
# Start local Supabase, configure .env files, and run migrations.
# Idempotent — safe to run repeatedly.

set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"

# ── Prerequisites ──────────────────────────────────────────────────────────

check_prereqs() {
  local missing=()
  if ! command -v docker &>/dev/null; then missing+=("docker"); fi
  if ! command -v supabase &>/dev/null; then missing+=("supabase CLI (npx supabase, brew install supabase/tap/supabase, etc.)"); fi
  if ! command -v jq &>/dev/null; then missing+=("jq"); fi

  if (( ${#missing[@]} )); then
    echo "Missing prerequisites:"
    for m in "${missing[@]}"; do echo "  - $m"; done
    exit 1
  fi

  if ! docker info &>/dev/null; then
    echo "Docker daemon is not running. Start Docker and try again."
    exit 1
  fi
}

# ── Signing Keys ───────────────────────────────────────────────────────────

ensure_signing_keys() {
  local keys_file="$BACKEND_DIR/supabase/signing_keys.json"
  local example_file="$BACKEND_DIR/supabase/signing_keys.json.example"

  if [[ -f "$keys_file" ]]; then
    return
  fi

  if [[ -f "$example_file" ]]; then
    cp "$example_file" "$keys_file"
    echo "Copied signing_keys.json.example -> signing_keys.json"
  else
    echo "Generating ES256 signing key..."
    (cd "$BACKEND_DIR" && supabase gen signing-key)
  fi
}

# ── Start Supabase ─────────────────────────────────────────────────────────

start_supabase() {
  echo "Starting local Supabase..."
  (cd "$BACKEND_DIR" && supabase start)
}

# ── Extract Status ─────────────────────────────────────────────────────────

extract_status() {
  (cd "$BACKEND_DIR" && supabase status --output json)
}

# ── Patch backend/.env ─────────────────────────────────────────────────────

patch_backend_env() {
  local status_json="$1"
  local env_file="$BACKEND_DIR/.env"

  local db_url
  db_url=$(echo "$status_json" | jq -r '.DB_URL')
  local api_url
  api_url=$(echo "$status_json" | jq -r '.API_URL')
  local service_role_key
  service_role_key=$(echo "$status_json" | jq -r '.SERVICE_ROLE_KEY')

  if [[ ! -f "$env_file" ]]; then
    cp "$BACKEND_DIR/.env.example" "$env_file"
    echo "Created backend/.env from .env.example"
  fi

  # Replace only the Supabase-related lines, preserve everything else
  local tmp
  tmp=$(mktemp)

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      SUPABASE_DB_URL=*)
        echo "SUPABASE_DB_URL=$db_url" ;;
      SUPABASE_URL=*)
        echo "SUPABASE_URL=$api_url" ;;
      SUPABASE_KEY=*)
        echo "SUPABASE_KEY=$service_role_key" ;;
      *)
        echo "$line" ;;
    esac
  done < "$env_file" > "$tmp"

  mv "$tmp" "$env_file"
  echo "Patched backend/.env with local Supabase values"
}

# ── Write frontend/.env.local ──────────────────────────────────────────────

write_frontend_env() {
  local status_json="$1"
  local env_file="$FRONTEND_DIR/.env.local"

  local api_url
  api_url=$(echo "$status_json" | jq -r '.API_URL')
  local anon_key
  anon_key=$(echo "$status_json" | jq -r '.ANON_KEY')

  cat > "$env_file" <<EOF
VITE_SUPABASE_URL=$api_url
VITE_SUPABASE_PUBLISHABLE_KEY=$anon_key
VITE_API_URL=http://localhost:$BACKEND_PORT
VITE_DEV_TOOLS=0
EOF

  echo "Wrote frontend/.env.local with local Supabase values"
}

# ── Run Migrations ─────────────────────────────────────────────────────────

run_migrations() {
  echo "Running database migrations..."
  (cd "$BACKEND_DIR" && make migrate-up)
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
  check_prereqs
  ensure_signing_keys
  start_supabase

  local status_json
  status_json=$(extract_status)

  patch_backend_env "$status_json"
  write_frontend_env "$status_json"
  run_migrations

  # Print summary
  local api_url studio_url inbucket_url db_url
  api_url=$(echo "$status_json" | jq -r '.API_URL')
  studio_url=$(echo "$status_json" | jq -r '.STUDIO_URL')
  inbucket_url=$(echo "$status_json" | jq -r '.INBUCKET_URL')
  db_url=$(echo "$status_json" | jq -r '.DB_URL')

  echo ""
  echo "=== Local Supabase Ready ==="
  echo "  API:      $api_url"
  echo "  Studio:   $studio_url"
  echo "  Inbucket: $inbucket_url"
  echo "  DB:       $db_url"
  echo ""
  echo "Next: run ./scripts/dev/setup.sh to start backend + frontend"
}

main
