-- +goose Up
-- +goose ENVSUB ON

-- =============================================================================
-- Skill Name Case-Insensitive Uniqueness
-- =============================================================================
-- This migration makes skill name uniqueness case-insensitive:
-- "WritingCoach" and "writingcoach" are treated as the same skill within a project.
-- Mixed case names are still stored as-is, only uniqueness check uses LOWER().
-- =============================================================================

-- Drop old case-sensitive unique index
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}project_skills_name;

-- Create case-insensitive unique index
-- Uses LOWER(name) to enforce uniqueness regardless of case
CREATE UNIQUE INDEX idx_${TABLE_PREFIX}project_skills_name
ON ${TABLE_PREFIX}project_skills(project_id, LOWER(name))
WHERE deleted_at IS NULL;

-- +goose Down
-- +goose ENVSUB ON

-- Restore case-sensitive unique index
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}project_skills_name;

CREATE UNIQUE INDEX idx_${TABLE_PREFIX}project_skills_name
ON ${TABLE_PREFIX}project_skills(project_id, name)
WHERE deleted_at IS NULL;
