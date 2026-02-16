-- +goose Up
-- +goose ENVSUB ON

-- Phase 1 collab foundations:
-- 1) Add Yjs storage columns on documents
-- 2) Add snapshot table for collab restore points/history

ALTER TABLE ${TABLE_PREFIX}documents
    ADD COLUMN IF NOT EXISTS yjs_state BYTEA;

ALTER TABLE ${TABLE_PREFIX}documents
    ADD COLUMN IF NOT EXISTS ai_content TEXT NOT NULL DEFAULT '';

-- Keep ai_content aligned with existing content for pre-collab rows.
UPDATE ${TABLE_PREFIX}documents
SET ai_content = content
WHERE ai_content = '' OR ai_content IS NULL;

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    yjs_state BYTEA NOT NULL,
    snapshot_type TEXT NOT NULL DEFAULT 'auto'
        CHECK (snapshot_type IN ('auto', 'named', 'pre_restore')),
    name TEXT,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_snapshot_doc_created
    ON ${TABLE_PREFIX}collab_document_snapshots(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_snapshot_type_created
    ON ${TABLE_PREFIX}collab_document_snapshots(snapshot_type, created_at DESC);

-- +goose Down
-- +goose ENVSUB ON

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_snapshot_type_created;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_snapshot_doc_created;

DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_snapshots;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP COLUMN IF EXISTS ai_content;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP COLUMN IF EXISTS yjs_state;
