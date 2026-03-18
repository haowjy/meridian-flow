-- +goose Up
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    DROP COLUMN IF EXISTS decided_by_user_id,
    DROP COLUMN IF EXISTS decided_at;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}collab_document_edit_proposals
    ADD COLUMN IF NOT EXISTS decided_by_user_id UUID,
    ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
