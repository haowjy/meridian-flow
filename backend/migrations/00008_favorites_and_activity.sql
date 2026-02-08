-- +goose Up
-- +goose ENVSUB ON

-- Part 0: Fix schema inconsistency - projects.user_id should be UUID, not TEXT
-- This aligns with user_preferences and enables proper auth.users foreign key
-- Existing TEXT UUIDs cast cleanly to UUID type

-- Drop dependent indexes first
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}projects_user_name;

-- Convert projects.user_id from TEXT to UUID
ALTER TABLE ${TABLE_PREFIX}projects
ALTER COLUMN user_id TYPE UUID USING user_id::uuid;

-- Add foreign key constraint to auth.users
ALTER TABLE ${TABLE_PREFIX}projects
ADD CONSTRAINT ${TABLE_PREFIX}projects_user_id_fkey
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Recreate index with UUID type
CREATE INDEX idx_${TABLE_PREFIX}projects_user_name ON ${TABLE_PREFIX}projects(user_id, name) WHERE deleted_at IS NULL;

-- Part 1: Junction table for user favorites
-- Favorites are per-user preferences (supports future sharing)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}user_project_favorites (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, project_id)
);

-- Index for "get all favorites for user" query (most common access pattern)
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}user_project_favorites_user
ON ${TABLE_PREFIX}user_project_favorites (user_id);

-- Part 2: Add last_activity_at column for tracking content activity
-- Separate from updated_at which changes on any project metadata update
ALTER TABLE ${TABLE_PREFIX}projects
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Initialize from existing updated_at (best approximation for existing data)
UPDATE ${TABLE_PREFIX}projects SET last_activity_at = updated_at;

-- Index for sorting projects by recent content activity
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}projects_user_last_activity
ON ${TABLE_PREFIX}projects (user_id, last_activity_at DESC)
WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}projects_user_last_activity;
ALTER TABLE ${TABLE_PREFIX}projects DROP COLUMN IF EXISTS last_activity_at;
DROP TABLE IF EXISTS ${TABLE_PREFIX}user_project_favorites;

-- Revert projects.user_id from UUID back to TEXT
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}projects_user_name;
ALTER TABLE ${TABLE_PREFIX}projects DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}projects_user_id_fkey;
ALTER TABLE ${TABLE_PREFIX}projects ALTER COLUMN user_id TYPE TEXT USING user_id::text;
CREATE INDEX idx_${TABLE_PREFIX}projects_user_name ON ${TABLE_PREFIX}projects(user_id, name) WHERE deleted_at IS NULL;
