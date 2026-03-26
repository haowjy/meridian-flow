-- +goose Up
-- +goose ENVSUB ON
-- Add 'system' role for bookmark turns (compaction, collapse_marker).
-- System turns are created by CompactionService and TokenMonitor (CM2/CM3) to manage
-- context window state. They are never user-authored and are filtered by MessageBuilder.
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_role_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_role_check
    CHECK (role IN ('user', 'assistant', 'system'));

-- +goose Down
-- +goose ENVSUB ON
-- Remove system turns first to satisfy the restored constraint.
DELETE FROM ${TABLE_PREFIX}turns WHERE role = 'system';
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_role_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_role_check
    CHECK (role IN ('user', 'assistant'));
