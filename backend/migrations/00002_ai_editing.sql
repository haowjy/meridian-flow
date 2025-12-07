-- +goose Up
-- +goose ENVSUB ON

-- AI Editing: Add ai_version column for AI document editing suggestions
-- AI writes to ai_version via doc_edit tool, frontend computes diff(content, ai_version)
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN ai_version TEXT;

-- Partial Blocks: Add status and updated_at columns to turn_blocks
-- Allows persisting partial text blocks when LLM response is interrupted
ALTER TABLE ${TABLE_PREFIX}turn_blocks
ADD COLUMN status TEXT DEFAULT 'complete' CHECK (status IN ('complete', 'partial'));

ALTER TABLE ${TABLE_PREFIX}turn_blocks
ADD COLUMN updated_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE ${TABLE_PREFIX}turn_blocks DROP COLUMN updated_at;
ALTER TABLE ${TABLE_PREFIX}turn_blocks DROP COLUMN status;
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN ai_version;
