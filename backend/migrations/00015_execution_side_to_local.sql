-- +goose Up
-- +goose ENVSUB ON

-- Migration: Rename execution_side values to "local"
-- This updates the execution_side column in turn_blocks to use "local"
-- instead of "server" or "backend" for consistency with the library constant name.
-- The library uses "local" to indicate non-provider execution (stop/execute/resume cycle).

UPDATE ${TABLE_PREFIX}turn_blocks
SET execution_side = 'local'
WHERE execution_side IN ('server', 'backend');

-- +goose Down
-- +goose ENVSUB ON

-- Revert to "backend" (previous value)
UPDATE ${TABLE_PREFIX}turn_blocks
SET execution_side = 'backend'
WHERE execution_side = 'local';
