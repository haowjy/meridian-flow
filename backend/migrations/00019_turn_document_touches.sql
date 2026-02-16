-- +goose Up
-- +goose ENVSUB ON

-- Phase 2: turn_document_touches read model.
-- Tracks which documents a turn touched (via document tool use),
-- enabling provenance-based review workflows ("what did the AI change?").

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}turn_document_touches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}threads(id) ON DELETE CASCADE,
    turn_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query pattern: "which documents did this turn touch?"
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}touch_turn
    ON ${TABLE_PREFIX}turn_document_touches(turn_id);

-- Query pattern: "which turns touched this document?" (newest first)
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}touch_doc_time
    ON ${TABLE_PREFIX}turn_document_touches(document_id, touched_at DESC);

-- Prevent duplicate touch records for the same turn+document pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}touch_turn_doc_unique
    ON ${TABLE_PREFIX}turn_document_touches(turn_id, document_id);

-- +goose Down
-- +goose ENVSUB ON

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}touch_turn_doc_unique;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}touch_doc_time;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}touch_turn;
DROP TABLE IF EXISTS ${TABLE_PREFIX}turn_document_touches;
