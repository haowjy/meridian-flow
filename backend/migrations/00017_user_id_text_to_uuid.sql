-- +goose Up
-- +goose ENVSUB ON

-- Migrate threads.user_id from TEXT to UUID for type consistency.
-- projects.user_id was already converted in 00008_favorites_and_activity.sql.
-- user_preferences.user_id has been UUID since initial schema.

ALTER TABLE ${TABLE_PREFIX}threads
    ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

-- Add foreign key constraint to auth.users (matching projects and user_preferences)
ALTER TABLE ${TABLE_PREFIX}threads
    ADD CONSTRAINT ${TABLE_PREFIX}threads_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- +goose Down
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}threads
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}threads_user_id_fkey;

ALTER TABLE ${TABLE_PREFIX}threads
    ALTER COLUMN user_id TYPE TEXT USING user_id::text;
