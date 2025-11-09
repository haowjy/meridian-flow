-- +goose Up
-- +goose ENVSUB ON
-- Add LLM request/response metadata to turns table

-- Add columns for comprehensive request/response tracking
ALTER TABLE ${TABLE_PREFIX}turns
    ADD COLUMN request_params JSONB,        -- All request parameters (temperature, max_tokens, thinking settings, etc.)
    ADD COLUMN stop_reason TEXT,             -- Why generation stopped (frequently queried, so separate column)
    ADD COLUMN response_metadata JSONB;      -- Provider-specific response data (stop_sequence, cache tokens, etc.)

-- Add index for common queries on stop_reason
CREATE INDEX IF NOT EXISTS idx_turns_stop_reason ON ${TABLE_PREFIX}turns(stop_reason) WHERE stop_reason IS NOT NULL;

-- Add GIN index for JSONB columns to enable efficient querying
CREATE INDEX IF NOT EXISTS idx_turns_request_params ON ${TABLE_PREFIX}turns USING GIN (request_params) WHERE request_params IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turns_response_metadata ON ${TABLE_PREFIX}turns USING GIN (response_metadata) WHERE response_metadata IS NOT NULL;

-- +goose Down
-- Remove indexes
DROP INDEX IF EXISTS ${TABLE_PREFIX}idx_turns_stop_reason;
DROP INDEX IF EXISTS ${TABLE_PREFIX}idx_turns_request_params;
DROP INDEX IF EXISTS ${TABLE_PREFIX}idx_turns_response_metadata;

-- Remove columns
ALTER TABLE ${TABLE_PREFIX}turns
    DROP COLUMN IF EXISTS request_params,
    DROP COLUMN IF EXISTS stop_reason,
    DROP COLUMN IF EXISTS response_metadata;
