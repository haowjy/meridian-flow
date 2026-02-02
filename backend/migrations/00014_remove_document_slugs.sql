-- +goose Up
-- +goose ENVSUB ON

-- Documents: remove slug column.
-- URLs now use document path (e.g., "Characters/Heroes/Aria.md") instead of slug.
-- The path is computed at runtime from folder hierarchy, not stored.
ALTER TABLE ${TABLE_PREFIX}documents
DROP COLUMN IF EXISTS slug;

-- +goose Down
-- +goose ENVSUB ON

-- This is a one-way migration - cannot restore slugs automatically.
-- To rollback, would need to regenerate slugs from document names and paths.
-- For safety, we add the column back but leave it NULL.
ALTER TABLE ${TABLE_PREFIX}documents
ADD COLUMN IF NOT EXISTS slug TEXT;

-- Note: Production rollback would require manual slug regeneration.
