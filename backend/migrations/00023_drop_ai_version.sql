-- +goose Up
-- +goose ENVSUB ON

-- Remove dead ai_version infrastructure.
-- The collab proposal system uses ai_content (separate column), not ai_version.
-- ai_version has zero writers and stale reads — safe to drop.
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS ai_version;
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS ai_version_rev;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN IF NOT EXISTS ai_version TEXT;
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN IF NOT EXISTS ai_version_rev INTEGER NOT NULL DEFAULT 0;
