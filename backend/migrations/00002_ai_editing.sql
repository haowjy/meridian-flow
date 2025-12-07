-- +goose Up
-- +goose ENVSUB ON

-- AI Editing: Add ai_version column for AI document editing suggestions
-- AI writes to ai_version via doc_edit tool, frontend computes diff(content, ai_version)
-- Using IF NOT EXISTS for idempotent SQL mode (safe to re-run)
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN IF NOT EXISTS ai_version TEXT;

-- Partial Blocks: Add status and updated_at columns to turn_blocks
-- Allows persisting partial text blocks when LLM response is interrupted
-- Note: CHECK constraint added inline - PostgreSQL ignores if column already exists with same constraint
ALTER TABLE ${TABLE_PREFIX}turn_blocks
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'complete' CHECK (status IN ('complete', 'partial'));

ALTER TABLE ${TABLE_PREFIX}turn_blocks
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE ${TABLE_PREFIX}turn_blocks DROP COLUMN IF EXISTS updated_at;
ALTER TABLE ${TABLE_PREFIX}turn_blocks DROP COLUMN IF EXISTS status;
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS ai_version;
