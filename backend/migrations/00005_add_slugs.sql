-- +goose Up
-- +goose ENVSUB ON

-- Add Slugs: User-friendly URL identifiers for projects and documents
-- - Project slugs: unique per user
-- - Document slugs: unique per project (not per folder)
-- - Mutable: slug updates when name changes

-- =============================================================================
-- HELPER FUNCTION: Generate URL-friendly slug from name
-- =============================================================================

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ${TABLE_PREFIX}generate_slug(name TEXT)
RETURNS TEXT AS $$func$$
BEGIN
    RETURN lower(
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    trim(name),
                    '[^a-zA-Z0-9\s-]', '', 'g'  -- Remove special chars except spaces and hyphens
                ),
                '\s+', '-', 'g'                 -- Replace spaces with hyphens
            ),
            '-+', '-', 'g'                      -- Collapse multiple hyphens
        )
    );
END;
$$func$$ LANGUAGE plpgsql IMMUTABLE;
-- +goose StatementEnd

-- =============================================================================
-- PROJECTS: Add slug column
-- =============================================================================

ALTER TABLE ${TABLE_PREFIX}projects
ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill existing projects with slugs generated from names
-- Handle collisions by appending -N suffix
-- +goose StatementBegin
DO $$body$$
DECLARE
    proj RECORD;
    base_slug TEXT;
    final_slug TEXT;
    suffix INT;
BEGIN
    FOR proj IN
        SELECT id, user_id, name
        FROM ${TABLE_PREFIX}projects
        WHERE slug IS NULL
    LOOP
        base_slug := ${TABLE_PREFIX}generate_slug(proj.name);
        final_slug := base_slug;
        suffix := 1;

        -- Find unique slug for this user
        WHILE EXISTS (
            SELECT 1 FROM ${TABLE_PREFIX}projects
            WHERE user_id = proj.user_id
            AND slug = final_slug
            AND deleted_at IS NULL
            AND id != proj.id
        ) LOOP
            suffix := suffix + 1;
            final_slug := base_slug || '-' || suffix;
        END LOOP;

        UPDATE ${TABLE_PREFIX}projects SET slug = final_slug WHERE id = proj.id;
    END LOOP;
END $$body$$;
-- +goose StatementEnd

-- Make slug NOT NULL after backfill
ALTER TABLE ${TABLE_PREFIX}projects
ALTER COLUMN slug SET NOT NULL;

-- Unique index: slug per user (excluding soft-deleted)
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_slug
ON ${TABLE_PREFIX}projects(user_id, slug)
WHERE deleted_at IS NULL;

-- =============================================================================
-- DOCUMENTS: Add slug column
-- =============================================================================

ALTER TABLE ${TABLE_PREFIX}documents
ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill existing documents with slugs generated from names
-- Handle collisions by appending -N suffix (unique per project)
-- +goose StatementBegin
DO $$body$$
DECLARE
    doc RECORD;
    base_slug TEXT;
    final_slug TEXT;
    suffix INT;
BEGIN
    FOR doc IN
        SELECT id, project_id, name
        FROM ${TABLE_PREFIX}documents
        WHERE slug IS NULL
    LOOP
        base_slug := ${TABLE_PREFIX}generate_slug(doc.name);
        final_slug := base_slug;
        suffix := 1;

        -- Find unique slug for this project
        WHILE EXISTS (
            SELECT 1 FROM ${TABLE_PREFIX}documents
            WHERE project_id = doc.project_id
            AND slug = final_slug
            AND deleted_at IS NULL
            AND id != doc.id
        ) LOOP
            suffix := suffix + 1;
            final_slug := base_slug || '-' || suffix;
        END LOOP;

        UPDATE ${TABLE_PREFIX}documents SET slug = final_slug WHERE id = doc.id;
    END LOOP;
END $$body$$;
-- +goose StatementEnd

-- Make slug NOT NULL after backfill
ALTER TABLE ${TABLE_PREFIX}documents
ALTER COLUMN slug SET NOT NULL;

-- Unique index: slug per project (excluding soft-deleted)
-- Note: Documents scoped to project, NOT folder
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_project_slug
ON ${TABLE_PREFIX}documents(project_id, slug)
WHERE deleted_at IS NULL;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON COLUMN ${TABLE_PREFIX}projects.slug IS 'URL-friendly identifier, unique per user, auto-generated from name';
COMMENT ON COLUMN ${TABLE_PREFIX}documents.slug IS 'URL-friendly identifier, unique per project, auto-generated from name';

-- +goose Down

-- Drop indexes
DROP INDEX IF EXISTS idx_documents_project_slug;
DROP INDEX IF EXISTS idx_projects_user_slug;

-- Drop slug columns
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS slug;
ALTER TABLE ${TABLE_PREFIX}projects DROP COLUMN IF EXISTS slug;

-- Drop helper function
DROP FUNCTION IF EXISTS ${TABLE_PREFIX}generate_slug(TEXT);
