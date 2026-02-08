# Migrations - Agent Instructions

This file applies to `backend/migrations/`.

## Non-Negotiable Rules

1. Always enable env substitution:
- `-- +goose ENVSUB ON` in Up and Down sections.

2. Always prefix app objects:
- Tables/functions: `${TABLE_PREFIX}...`
- Index names: `idx_${TABLE_PREFIX}...`
- Constraint names: `${TABLE_PREFIX}...`

3. Never hardcode environment names in migrations:
- Do not write `dev_`, `test_`, `prod_` directly for app tables/indexes.

4. Keep Up and Down symmetric:
- If Up creates/renames/drops prefixed objects, Down must reverse using the same prefix pattern.

5. Use goose block markers correctly:
- `-- +goose Up`
- `-- +goose Down`
- `-- +goose StatementBegin` / `-- +goose StatementEnd` for PL/pgSQL blocks.

## Required Workflow Before Editing

Read first:
1. `00001_initial_schema.sql` (baseline conventions)
2. The latest migration file (current style)
3. One migration with similar operation type (index/constraint/rename/function)

Then implement using the same patterns.

## Legacy Compatibility Exceptions

If you must reference legacy unprefixed objects (cleanup/backfill):
- Keep it explicit.
- Add a short comment explaining why it is intentionally unprefixed.
- Prefer one-time scripts under `backend/scripts/` for broad legacy repair logic.
