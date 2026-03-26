-- +goose Up
-- +goose ENVSUB ON
-- Attach threads to work items via a nullable FK.
-- Nullable so existing rows keep NULL and get ephemeral work items provisioned
-- lazily on first agent runtime access. ON DELETE SET NULL preserves thread
-- history if a work item is ever hard-deleted in future cleanup jobs.

ALTER TABLE ${TABLE_PREFIX}threads
    ADD COLUMN work_item_id UUID REFERENCES ${TABLE_PREFIX}work_items(id) ON DELETE SET NULL;

-- Cover index for: list threads by work item, ordered by updated_at desc.
-- Leading column is work_item_id because ListThreads, CountAttachedThreads,
-- and HasStreamingThreads all filter by work_item_id alone — no project_id
-- predicate. A project_id leading column would make this index unusable.
CREATE INDEX idx_${TABLE_PREFIX}threads_work_item
    ON ${TABLE_PREFIX}threads(work_item_id, updated_at DESC, id DESC)
    WHERE deleted_at IS NULL AND work_item_id IS NOT NULL;

-- +goose Down
-- +goose ENVSUB ON
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}threads_work_item;
ALTER TABLE ${TABLE_PREFIX}threads DROP COLUMN IF EXISTS work_item_id;
