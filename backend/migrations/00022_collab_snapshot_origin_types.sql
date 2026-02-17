-- +goose Up
-- +goose ENVSUB ON

-- Expand snapshot_type CHECK constraint to support origin-aware auto snapshots.
-- Legacy 'auto' remains valid for backward compatibility with existing data.
-- New types: 'auto_human' (from user editing) and 'auto_ai_accept' (from AI proposal acceptance).

ALTER TABLE ${TABLE_PREFIX}collab_document_snapshots
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}collab_document_snapshots_snapshot_type_check;

ALTER TABLE ${TABLE_PREFIX}collab_document_snapshots
    ADD CONSTRAINT ${TABLE_PREFIX}collab_document_snapshots_snapshot_type_check
    CHECK (snapshot_type IN ('auto', 'auto_human', 'auto_ai_accept', 'named', 'pre_restore'));

-- +goose Down
-- +goose ENVSUB ON

-- Restore original constraint (blocks rollback if new types exist in data).
ALTER TABLE ${TABLE_PREFIX}collab_document_snapshots
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}collab_document_snapshots_snapshot_type_check;

ALTER TABLE ${TABLE_PREFIX}collab_document_snapshots
    ADD CONSTRAINT ${TABLE_PREFIX}collab_document_snapshots_snapshot_type_check
    CHECK (snapshot_type IN ('auto', 'named', 'pre_restore'));
