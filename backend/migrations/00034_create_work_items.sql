-- +goose Up
-- +goose ENVSUB ON
-- Work items: named units of work that own multiple threads and a shared
-- artifact folder at .meridian/work/<slug>/. Status is active or done;
-- deletion is handled by soft-delete (deleted_at), not a status value.

CREATE TABLE ${TABLE_PREFIX}work_items (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id   UUID        NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    slug         TEXT        NOT NULL,
    description  TEXT,
    status       TEXT        NOT NULL DEFAULT 'active',
    is_ephemeral BOOLEAN     NOT NULL DEFAULT FALSE,
    metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ,
    CONSTRAINT ${TABLE_PREFIX}work_items_status_check
        CHECK (status IN ('active', 'done')),
    CONSTRAINT ${TABLE_PREFIX}work_items_slug_check
        CHECK (
            char_length(slug) BETWEEN 1 AND 80
            AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$$'
        ),
    CONSTRAINT ${TABLE_PREFIX}work_items_metadata_check
        CHECK (jsonb_typeof(metadata) = 'object')
);

-- Partial unique: no duplicate active slugs per project (deleted items don't
-- block re-use of the same slug).
CREATE UNIQUE INDEX idx_${TABLE_PREFIX}work_items_project_slug_active
    ON ${TABLE_PREFIX}work_items(project_id, slug)
    WHERE deleted_at IS NULL;

-- Cover index for the most common list query: all non-deleted items in a
-- project sorted by creation time, optionally filtered by status.
CREATE INDEX idx_${TABLE_PREFIX}work_items_project_status
    ON ${TABLE_PREFIX}work_items(project_id, status, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

-- Support CountActiveEphemerals used for ephemeral work-item cap enforcement.
CREATE INDEX idx_${TABLE_PREFIX}work_items_project_ephemeral
    ON ${TABLE_PREFIX}work_items(project_id, is_ephemeral, status)
    WHERE deleted_at IS NULL;

-- updated_at auto-trigger reuses the shared function created in migration 00001.
CREATE TRIGGER update_work_items_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}work_items
    FOR EACH ROW EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

-- +goose Down
-- +goose ENVSUB ON
DROP TRIGGER IF EXISTS update_work_items_updated_at ON ${TABLE_PREFIX}work_items;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}work_items_project_ephemeral;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}work_items_project_status;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}work_items_project_slug_active;
DROP TABLE IF EXISTS ${TABLE_PREFIX}work_items;
