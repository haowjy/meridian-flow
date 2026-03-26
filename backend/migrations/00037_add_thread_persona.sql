-- +goose Up
-- +goose ENVSUB ON
-- Add persona column to threads for storing the persona slug used when creating the thread.
-- Nullable: existing threads have no persona (NULL). New threads with a persona get the slug.

ALTER TABLE ${TABLE_PREFIX}threads ADD COLUMN persona TEXT;

-- +goose Down
-- +goose ENVSUB ON
ALTER TABLE ${TABLE_PREFIX}threads DROP COLUMN IF EXISTS persona;
