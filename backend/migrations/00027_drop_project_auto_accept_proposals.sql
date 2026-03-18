-- +goose Up
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}projects
    DROP COLUMN IF EXISTS auto_accept_proposals;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}projects
    ADD COLUMN IF NOT EXISTS auto_accept_proposals BOOLEAN;
