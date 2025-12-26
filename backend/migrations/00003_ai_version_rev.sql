-- +goose Up
-- +goose ENVSUB ON

-- AI Version Revision: Add revision counter for optimistic concurrency control
-- Frontend sends ai_version_base_rev when updating ai_version.
-- Server checks current rev matches before applying update (CAS).
-- Prevents frontend from overwriting unseen AI updates.
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN IF NOT EXISTS ai_version_rev INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS ai_version_rev;
