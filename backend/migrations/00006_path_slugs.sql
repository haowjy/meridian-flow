-- +goose Up
-- +goose ENVSUB ON

-- Migration: Convert document slugs from project-scoped to path-based
-- Before: "readme" (unique per project)
-- After: "characters/heroes/aria" (includes folder path)

-- =============================================================================
-- HELPER FUNCTION: Build folder path recursively and slugify each segment
-- =============================================================================

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ${TABLE_PREFIX}build_folder_slug_path(folder_uuid UUID)
RETURNS TEXT AS $$func$$
DECLARE
    result TEXT;
BEGIN
    WITH RECURSIVE folder_hierarchy AS (
        -- Base case: start from the folder itself
        SELECT id, parent_id, name, 1 as depth
        FROM ${TABLE_PREFIX}folders
        WHERE id = folder_uuid AND deleted_at IS NULL
        UNION ALL
        -- Recursive case: walk up the tree
        SELECT f.id, f.parent_id, f.name, fh.depth + 1
        FROM ${TABLE_PREFIX}folders f
        JOIN folder_hierarchy fh ON f.id = fh.parent_id
        WHERE f.deleted_at IS NULL
    )
    SELECT string_agg(
        -- Convert each folder name to slug format:
        -- lowercase, replace spaces with hyphens, remove special chars
        regexp_replace(
            regexp_replace(
                lower(trim(name)),
                '\s+', '-', 'g'
            ),
            '[^a-z0-9-]', '', 'g'
        ),
        '/' ORDER BY depth DESC
    ) INTO result
    FROM folder_hierarchy;

    RETURN result;
END;
$$func$$ LANGUAGE plpgsql STABLE;
-- +goose StatementEnd

-- =============================================================================
-- UPDATE DOCUMENTS: Prepend slugified folder path to existing slug
-- =============================================================================

-- +goose StatementBegin
DO $$body$$
DECLARE
    doc RECORD;
    folder_path TEXT;
    new_slug TEXT;
BEGIN
    FOR doc IN
        SELECT id, folder_id, slug
        FROM ${TABLE_PREFIX}documents
        WHERE folder_id IS NOT NULL
          AND deleted_at IS NULL
    LOOP
        folder_path := ${TABLE_PREFIX}build_folder_slug_path(doc.folder_id);

        -- Only update if we got a valid folder path
        IF folder_path IS NOT NULL AND folder_path != '' THEN
            new_slug := folder_path || '/' || doc.slug;
            UPDATE ${TABLE_PREFIX}documents SET slug = new_slug WHERE id = doc.id;
        END IF;
    END LOOP;
END $$body$$;
-- +goose StatementEnd

-- =============================================================================
-- CLEANUP: Drop helper function (not needed at runtime - app code handles this)
-- =============================================================================

DROP FUNCTION IF EXISTS ${TABLE_PREFIX}build_folder_slug_path(UUID);

-- +goose Down
-- +goose ENVSUB ON

-- Note: Cannot reliably reverse this migration
-- The original project-scoped slugs are lost when folder path is prepended
-- Partial rollback: strip folder path prefix from slugs (extract last segment)

-- +goose StatementBegin
DO $$body$$
BEGIN
    -- Extract last segment after final '/' using reverse/split_part trick
    -- Avoids regex with $ which conflicts with goose ENVSUB
    UPDATE ${TABLE_PREFIX}documents
    SET slug = CASE
        WHEN position('/' in slug) > 0 THEN
            reverse(split_part(reverse(slug), '/', 1))
        ELSE
            slug
    END
    WHERE deleted_at IS NULL;
END $$body$$;
-- +goose StatementEnd
