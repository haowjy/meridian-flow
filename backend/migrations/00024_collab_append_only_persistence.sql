-- +goose Up
-- +goose ENVSUB ON

-- Phase 0 append-only persistence:
-- 1) Add update-log + checkpoint + bookmark tables
-- 2) Migrate legacy yjs_state + snapshots data
-- 3) Remove legacy snapshot table + documents.yjs_state column

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_updates (
    id BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    update BYTEA NOT NULL,
    origin TEXT,
    user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_updates_doc_id
    ON ${TABLE_PREFIX}collab_document_updates(document_id, id);

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_checkpoints (
    id BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    state BYTEA NOT NULL,
    up_to_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_checkpoints_doc_desc
    ON ${TABLE_PREFIX}collab_document_checkpoints(document_id, id DESC);

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    update_id BIGINT,
    state BYTEA,
    bookmark_type TEXT NOT NULL,
    turn_id UUID,
    name TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ${TABLE_PREFIX}collab_document_bookmarks_doc_turn_type_unique
        UNIQUE (document_id, turn_id, bookmark_type)
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_bookmarks_doc_type
    ON ${TABLE_PREFIX}collab_document_bookmarks(document_id, bookmark_type);

-- Migrate existing document Yjs state into checkpoints so loadState can replay from append-only tables.
INSERT INTO ${TABLE_PREFIX}collab_document_checkpoints (document_id, state, up_to_id, created_at)
SELECT d.id, d.yjs_state, 0, NOW()
FROM ${TABLE_PREFIX}documents d
WHERE d.yjs_state IS NOT NULL
  AND OCTET_LENGTH(d.yjs_state) > 0;

-- Migrate legacy snapshots into materialized bookmarks.
INSERT INTO ${TABLE_PREFIX}collab_document_bookmarks (
    document_id,
    update_id,
    state,
    bookmark_type,
    turn_id,
    name,
    created_by,
    created_at
)
SELECT
    s.document_id,
    NULL,
    s.yjs_state,
    CASE
        WHEN s.snapshot_type = 'named' THEN 'manual'
        WHEN s.snapshot_type = 'pre_restore' THEN 'safety_restore'
        ELSE 'daily'
    END,
    NULL,
    s.name,
    s.created_by_user_id,
    s.created_at
FROM ${TABLE_PREFIX}collab_document_snapshots s;

DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_snapshots;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP COLUMN IF EXISTS yjs_state;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}documents
    ADD COLUMN IF NOT EXISTS yjs_state BYTEA;

-- Best-effort rollback: restore yjs_state from latest checkpoint.
UPDATE ${TABLE_PREFIX}documents d
SET yjs_state = c.state
FROM (
    SELECT DISTINCT ON (document_id) document_id, state
    FROM ${TABLE_PREFIX}collab_document_checkpoints
    ORDER BY document_id, id DESC
) c
WHERE d.id = c.document_id;

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    yjs_state BYTEA NOT NULL,
    snapshot_type TEXT NOT NULL DEFAULT 'auto'
        CHECK (snapshot_type IN ('auto', 'auto_human', 'auto_ai_accept', 'named', 'pre_restore')),
    name TEXT,
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_snapshot_doc_created
    ON ${TABLE_PREFIX}collab_document_snapshots(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_snapshot_type_created
    ON ${TABLE_PREFIX}collab_document_snapshots(snapshot_type, created_at DESC);

INSERT INTO ${TABLE_PREFIX}collab_document_snapshots (
    document_id,
    yjs_state,
    snapshot_type,
    name,
    created_by_user_id,
    created_at
)
SELECT
    b.document_id,
    b.state,
    CASE
        WHEN b.bookmark_type = 'manual' THEN 'named'
        WHEN b.bookmark_type = 'safety_restore' THEN 'pre_restore'
        ELSE 'auto'
    END,
    b.name,
    b.created_by,
    b.created_at
FROM ${TABLE_PREFIX}collab_document_bookmarks b
WHERE b.state IS NOT NULL
  AND b.bookmark_type IN ('manual', 'daily', 'safety_restore');

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_bookmarks_doc_type;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_bookmarks;

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_checkpoints_doc_desc;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_checkpoints;

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_updates_doc_id;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_updates;
