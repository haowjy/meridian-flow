-- +goose Up
-- +goose ENVSUB ON
-- Add system prompt support for projects and chats

-- Add system_prompt to projects table
ALTER TABLE ${TABLE_PREFIX}projects
ADD COLUMN system_prompt TEXT;

COMMENT ON COLUMN ${TABLE_PREFIX}projects.system_prompt IS 'Base system prompt for all chats in this project';

-- Add system_prompt to chats table
ALTER TABLE ${TABLE_PREFIX}chats
ADD COLUMN system_prompt TEXT;

COMMENT ON COLUMN ${TABLE_PREFIX}chats.system_prompt IS 'Chat-specific system prompt extension';

-- Mark turns.system_prompt as deprecated
COMMENT ON COLUMN ${TABLE_PREFIX}turns.system_prompt IS 'DEPRECATED: Not used. System prompts are resolved from project.system_prompt + chat.system_prompt + selected skills at request time. This field will be removed in a future migration.';

-- +goose Down
-- Remove comments
COMMENT ON COLUMN ${TABLE_PREFIX}turns.system_prompt IS NULL;
COMMENT ON COLUMN ${TABLE_PREFIX}chats.system_prompt IS NULL;
COMMENT ON COLUMN ${TABLE_PREFIX}projects.system_prompt IS NULL;

-- Remove columns
ALTER TABLE ${TABLE_PREFIX}chats
DROP COLUMN IF EXISTS system_prompt;

ALTER TABLE ${TABLE_PREFIX}projects
DROP COLUMN IF EXISTS system_prompt;
