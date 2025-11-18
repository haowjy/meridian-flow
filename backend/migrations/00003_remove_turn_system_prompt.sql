-- +goose Up
-- +goose ENVSUB ON
-- Remove deprecated system_prompt column from turns table
-- System prompts are now resolved from:
--   1. request_params.system (user-provided)
--   2. project.system_prompt
--   3. chat.system_prompt
--   4. selected skills (.skills/{name}/SKILL)

ALTER TABLE ${TABLE_PREFIX}turns
DROP COLUMN IF EXISTS system_prompt;

-- +goose Down
-- Re-add system_prompt column for rollback
ALTER TABLE ${TABLE_PREFIX}turns
ADD COLUMN system_prompt TEXT;

COMMENT ON COLUMN ${TABLE_PREFIX}turns.system_prompt IS 'DEPRECATED: Not used. System prompts are resolved from project.system_prompt + chat.system_prompt + selected skills at request time.';
