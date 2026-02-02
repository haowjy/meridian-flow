-- +goose Up
-- +goose ENVSUB ON

-- =============================================================================
-- Skill and Project Updates
-- =============================================================================
-- 1. Add enabled field to skills (allow enable/disable per project)
-- 2. Add preferences JSONB to projects (disabled tools, future settings)
-- 3. Add content column to skills (store in DB instead of SKILL.md)
-- =============================================================================

-- 1. Add enabled column to project_skills (default: enabled)
ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- Index for querying enabled skills
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}project_skills_enabled
ON ${TABLE_PREFIX}project_skills (project_id, enabled) WHERE deleted_at IS NULL;

-- 2. Add preferences JSONB to projects
ALTER TABLE ${TABLE_PREFIX}projects
ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- 3. Add content column to store skill instructions directly in DB
ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}project_skills DROP COLUMN IF EXISTS content;
ALTER TABLE ${TABLE_PREFIX}projects DROP COLUMN IF EXISTS preferences;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}project_skills_enabled;
ALTER TABLE ${TABLE_PREFIX}project_skills DROP COLUMN IF EXISTS enabled;
