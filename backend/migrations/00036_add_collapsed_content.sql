-- +goose Up
-- +goose ENVSUB ON
-- Add collapsed_content column to turn_blocks for human-readable tool result summaries.
-- Nullable: existing blocks keep NULL. New tool result blocks get a human-readable summary
-- like "[Read /path: 1234 chars]" or "[Searched 'query': 5 results]".

ALTER TABLE ${TABLE_PREFIX}turn_blocks ADD COLUMN collapsed_content TEXT;

-- +goose Down
-- +goose ENVSUB ON
ALTER TABLE ${TABLE_PREFIX}turn_blocks DROP COLUMN IF EXISTS collapsed_content;
