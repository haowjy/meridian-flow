-- +goose Up
-- +goose ENVSUB ON
-- Adds credit_limited to the turn status CHECK constraint
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_status_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_status_check
    CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error', 'credit_limited'));

-- +goose Down
-- +goose ENVSUB ON
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_status_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_status_check
    CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error'));
