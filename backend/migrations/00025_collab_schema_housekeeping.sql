-- +goose Up
-- +goose ENVSUB ON

-- Phase 1 schema housekeeping:
-- 1) Rename proposal lifecycle default from proposed -> pending
-- 2) Expand proposal status CHECK for v2 states
-- 3) Add proposal context + offset tracking columns
-- 4) Remove documents.ai_content (append-only + projection pipeline path)

UPDATE ${TABLE_PREFIX}collab_document_edit_proposals
SET status = 'pending'
WHERE status = 'proposed';

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    DROP CONSTRAINT IF EXISTS collab_document_edit_proposals_status_check,
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}collab_document_edit_proposals_status_check;

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    ADD CONSTRAINT ${TABLE_PREFIX}collab_document_edit_proposals_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'stale', 'reverted', 'invalid'));

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    ADD COLUMN IF NOT EXISTS region_text_before TEXT,
    ADD COLUMN IF NOT EXISTS region_text_after TEXT,
    ADD COLUMN IF NOT EXISTS proposed_at_offset INT,
    ADD COLUMN IF NOT EXISTS accepted_at_offset INT,
    ADD COLUMN IF NOT EXISTS offset_version INT NOT NULL DEFAULT 0;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP COLUMN IF EXISTS ai_content;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}documents
    ADD COLUMN IF NOT EXISTS ai_content TEXT NOT NULL DEFAULT '';

UPDATE ${TABLE_PREFIX}documents
SET ai_content = content
WHERE ai_content = '' OR ai_content IS NULL;

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    DROP CONSTRAINT IF EXISTS collab_document_edit_proposals_status_check,
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}collab_document_edit_proposals_status_check;

UPDATE ${TABLE_PREFIX}collab_document_edit_proposals
SET status = 'rejected'
WHERE status IN ('stale', 'reverted', 'invalid');

UPDATE ${TABLE_PREFIX}collab_document_edit_proposals
SET status = 'proposed'
WHERE status = 'pending';

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    DROP COLUMN IF EXISTS region_text_before,
    DROP COLUMN IF EXISTS region_text_after,
    DROP COLUMN IF EXISTS proposed_at_offset,
    DROP COLUMN IF EXISTS accepted_at_offset,
    DROP COLUMN IF EXISTS offset_version;

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    ADD CONSTRAINT ${TABLE_PREFIX}collab_document_edit_proposals_status_check
    CHECK (status IN ('proposed', 'accepted', 'rejected'));
