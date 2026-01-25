-- +goose Up
-- +goose ENVSUB ON

-- =============================================================================
-- Skills and Metadata Migration (Consolidated)
-- =============================================================================
-- This migration adds:
-- 1. is_hidden column on folders (for skill namespace folders like /.meridian/)
-- 2. project_skills table for skill metadata
-- 3. Partial unique indexes for documents/folders (respects soft-deletes)
-- 4. Drops legacy slug unique index (caused skill creation issues)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Folder visibility (for hidden namespace folders)
-- -----------------------------------------------------------------------------

-- Add is_hidden column for namespace support (/.meridian/, etc.)
-- Hidden folders are excluded from tree API by default
ALTER TABLE ${TABLE_PREFIX}folders
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;

-- Index for filtering by visibility in tree queries
CREATE INDEX IF NOT EXISTS idx_folders_project_hidden
ON ${TABLE_PREFIX}folders(project_id, is_hidden)
WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Project Skills table
-- -----------------------------------------------------------------------------

-- Skills are stored under /.meridian/skills/<name>/ folders
-- This table tracks skill metadata and links to the instance folder
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}project_skills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    instance_folder_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}folders(id),
    name TEXT NOT NULL,              -- Skill identifier (e.g., "writing-coach")
    display_name TEXT NOT NULL,      -- Human-readable name
    description TEXT NOT NULL,       -- Short description for context
    position INTEGER NOT NULL DEFAULT 0,
    -- Invocation control
    disable_model_invocation BOOLEAN NOT NULL DEFAULT FALSE,
    user_invocable BOOLEAN NOT NULL DEFAULT TRUE,
    -- Future template linking
    source_template_version_id UUID,
    sync_state TEXT NOT NULL DEFAULT 'detached',
    is_dirty BOOLEAN NOT NULL DEFAULT FALSE,
    last_synced_at TIMESTAMPTZ,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Partial unique indexes for soft-delete compatibility
-- Skill name must be unique per project (among non-deleted skills)
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skills_name
ON ${TABLE_PREFIX}project_skills(project_id, name)
WHERE deleted_at IS NULL;

-- Each folder can only be associated with one skill
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_skills_folder
ON ${TABLE_PREFIX}project_skills(project_id, instance_folder_id)
WHERE deleted_at IS NULL;

-- Index for listing skills by project (most common query)
CREATE INDEX IF NOT EXISTS idx_project_skills_project
ON ${TABLE_PREFIX}project_skills(project_id)
WHERE deleted_at IS NULL;

-- Trigger for auto-updating updated_at (idempotent - drops if exists first)
DROP TRIGGER IF EXISTS update_project_skills_updated_at ON ${TABLE_PREFIX}project_skills;
CREATE TRIGGER update_project_skills_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}project_skills
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

-- RLS (block PostgREST API access)
ALTER TABLE ${TABLE_PREFIX}project_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "block_postgrest" ON ${TABLE_PREFIX}project_skills;
CREATE POLICY "block_postgrest" ON ${TABLE_PREFIX}project_skills FOR ALL USING (false);

-- -----------------------------------------------------------------------------
-- 3. Fix unique constraints for soft-delete compatibility
-- -----------------------------------------------------------------------------

-- Documents: Drop old table-level constraint, use partial index instead
-- Problem: Old constraint blocks inserts even when matching rows are soft-deleted
-- Solution: Partial index only enforces uniqueness on active (non-deleted) rows
ALTER TABLE ${TABLE_PREFIX}documents
DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_project_id_folder_id_name_extension_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_folder_unique_active
ON ${TABLE_PREFIX}documents(project_id, folder_id, name, extension)
WHERE folder_id IS NOT NULL AND deleted_at IS NULL;

-- Folders: Same pattern - partial index for soft-delete compatibility
ALTER TABLE ${TABLE_PREFIX}folders
DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}folders_project_id_parent_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_parent_unique_active
ON ${TABLE_PREFIX}folders(project_id, parent_id, name)
WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Drop legacy slug unique index
-- -----------------------------------------------------------------------------

-- Slugs are legacy and no longer used for uniqueness enforcement
-- This was blocking skill creation because all SKILL.md documents
-- generated the same slug "skill", causing conflicts
DROP INDEX IF EXISTS idx_documents_project_slug;

-- +goose Down

-- Restore slug unique index
CREATE UNIQUE INDEX idx_documents_project_slug
ON ${TABLE_PREFIX}documents(project_id, slug)
WHERE deleted_at IS NULL;

-- Restore folder unique constraint (WARNING: requires no soft-deleted duplicates)
DROP INDEX IF EXISTS idx_folders_parent_unique_active;
ALTER TABLE ${TABLE_PREFIX}folders
ADD CONSTRAINT ${TABLE_PREFIX}folders_project_id_parent_id_name_key
UNIQUE(project_id, parent_id, name);

-- Restore document unique constraint (WARNING: requires no soft-deleted duplicates)
DROP INDEX IF EXISTS idx_documents_folder_unique_active;
ALTER TABLE ${TABLE_PREFIX}documents
ADD CONSTRAINT ${TABLE_PREFIX}documents_project_id_folder_id_name_extension_key
UNIQUE(project_id, folder_id, name, extension);

-- Drop project_skills table
DROP POLICY IF EXISTS "block_postgrest" ON ${TABLE_PREFIX}project_skills;
ALTER TABLE ${TABLE_PREFIX}project_skills DISABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS update_project_skills_updated_at ON ${TABLE_PREFIX}project_skills;
DROP INDEX IF EXISTS idx_project_skills_project;
DROP INDEX IF EXISTS idx_project_skills_folder;
DROP INDEX IF EXISTS idx_project_skills_name;
DROP TABLE IF EXISTS ${TABLE_PREFIX}project_skills;

-- Drop folder hidden column
DROP INDEX IF EXISTS idx_folders_project_hidden;
ALTER TABLE ${TABLE_PREFIX}folders DROP COLUMN IF EXISTS is_hidden;
