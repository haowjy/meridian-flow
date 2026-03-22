#!/usr/bin/env bash
# Lint SQL migration files for project conventions.
# Usage: ./scripts/lint-migrations.sh [file ...]
# If no files given, checks all backend/migrations/*.sql

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$(cd "$SCRIPT_DIR/../migrations" && pwd)"

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

errors=0
warnings=0

lint_file() {
  local f="$1"
  local basename
  basename="$(basename "$f")"

  # 1. Must have -- +goose Up
  if ! grep -q "+goose Up" "$f"; then
    echo -e "${RED}ERROR${NC} $basename: missing '-- +goose Up'"
    ((errors++))
  fi

  # 2. Must have -- +goose Down
  if ! grep -q "+goose Down" "$f"; then
    echo -e "${RED}ERROR${NC} $basename: missing '-- +goose Down'"
    ((errors++))
  fi

  # 3. Must have ENVSUB ON (at least once)
  if ! grep -q "ENVSUB ON" "$f"; then
    echo -e "${RED}ERROR${NC} $basename: missing '-- +goose ENVSUB ON'"
    ((errors++))
  fi

  # 4. No hardcoded dev_/test_/prod_ table prefixes in SQL statements
  # Skip comments (lines starting with --) and goose directives
  local hardcoded
  hardcoded=$(grep -nE '\b(dev_|test_|prod_)[a-z]' "$f" \
    | grep -v '^[0-9]*:\s*--' \
    | grep -v 'TABLE_PREFIX' \
    | grep -v 'ENVSUB' \
    | grep -v '+goose' || true)
  if [[ -n "$hardcoded" ]]; then
    echo -e "${RED}ERROR${NC} $basename: hardcoded environment prefix found:"
    echo "$hardcoded" | sed 's/^/  /'
    ((errors++))
  fi

  # 5. CREATE TABLE/INDEX/TYPE/FUNCTION should use ${TABLE_PREFIX}
  local unprefixed
  unprefixed=$(grep -nEi 'CREATE\s+(TABLE|INDEX|UNIQUE INDEX|TYPE|FUNCTION|VIEW)\s+' "$f" \
    | grep -v 'TABLE_PREFIX' \
    | grep -v '^[0-9]*:\s*--' \
    | grep -v 'IF NOT EXISTS pg_' \
    | grep -v 'btree_gist' || true)
  if [[ -n "$unprefixed" ]]; then
    echo -e "${RED}ERROR${NC} $basename: CREATE statement without \${TABLE_PREFIX}:"
    echo "$unprefixed" | sed 's/^/  /'
    ((errors++))
  fi

  # 6. DROP TABLE/INDEX/TYPE/FUNCTION should use ${TABLE_PREFIX}
  local unprefixed_drop
  unprefixed_drop=$(grep -nEi 'DROP\s+(TABLE|INDEX|TYPE|FUNCTION|VIEW)\s+' "$f" \
    | grep -v 'TABLE_PREFIX' \
    | grep -v '^[0-9]*:\s*--' \
    | grep -v 'IF EXISTS pg_' \
    | grep -v 'btree_gist' || true)
  if [[ -n "$unprefixed_drop" ]]; then
    echo -e "${RED}ERROR${NC} $basename: DROP statement without \${TABLE_PREFIX}:"
    echo "$unprefixed_drop" | sed 's/^/  /'
    ((errors++))
  fi

  # 7. ALTER TABLE should use ${TABLE_PREFIX}
  local unprefixed_alter
  unprefixed_alter=$(grep -nEi 'ALTER\s+TABLE\s+' "$f" \
    | grep -v 'TABLE_PREFIX' \
    | grep -v '^\s*--' || true)
  if [[ -n "$unprefixed_alter" ]]; then
    echo -e "${RED}ERROR${NC} $basename: ALTER TABLE without \${TABLE_PREFIX}:"
    echo "$unprefixed_alter" | sed 's/^/  /'
    ((errors++))
  fi

  # 8. Constraint names should use ${TABLE_PREFIX} (ADD CONSTRAINT)
  local unprefixed_constraint
  unprefixed_constraint=$(grep -nEi 'ADD\s+CONSTRAINT\s+' "$f" \
    | grep -v 'TABLE_PREFIX' \
    | grep -v '^\s*--' || true)
  if [[ -n "$unprefixed_constraint" ]]; then
    echo -e "${YELLOW}WARN${NC} $basename: ADD CONSTRAINT without \${TABLE_PREFIX}:"
    echo "$unprefixed_constraint" | sed 's/^/  /'
    ((warnings++))
  fi
}

# Determine which files to check
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  files=("$MIGRATIONS_DIR"/*.sql)
fi

echo "Linting ${#files[@]} migration file(s)..."
echo ""

for f in "${files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo -e "${RED}ERROR${NC} File not found: $f"
    ((errors++))
    continue
  fi
  lint_file "$f"
done

echo ""
if [[ $errors -eq 0 && $warnings -eq 0 ]]; then
  echo -e "${GREEN}All migrations pass.${NC}"
  exit 0
elif [[ $errors -eq 0 ]]; then
  echo -e "${YELLOW}${warnings} warning(s), 0 errors.${NC}"
  exit 0
else
  echo -e "${RED}${errors} error(s), ${warnings} warning(s).${NC}"
  exit 1
fi
