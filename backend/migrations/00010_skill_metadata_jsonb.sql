-- +goose Up
-- +goose ENVSUB ON

-- =============================================================================
-- Skills Metadata JSONB Migration
-- =============================================================================
-- This migration consolidates skill metadata into a JSONB column:
-- 1. Adds metadata JSONB column
-- 2. Backfills from existing disable_model_invocation and user_invocable columns
-- 3. Drops legacy columns
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add metadata JSONB column
-- -----------------------------------------------------------------------------

ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- -----------------------------------------------------------------------------
-- 2. Backfill metadata from existing columns
-- -----------------------------------------------------------------------------

UPDATE ${TABLE_PREFIX}project_skills
SET metadata = jsonb_build_object(
    'disableModelInvocation', disable_model_invocation,
    'userInvocable', user_invocable
);

-- -----------------------------------------------------------------------------
-- 3. Drop legacy columns
-- -----------------------------------------------------------------------------

ALTER TABLE ${TABLE_PREFIX}project_skills
DROP COLUMN IF EXISTS disable_model_invocation;

ALTER TABLE ${TABLE_PREFIX}project_skills
DROP COLUMN IF EXISTS user_invocable;

-- +goose Down

-- Restore legacy columns
ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS disable_model_invocation BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS user_invocable BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill from metadata
UPDATE ${TABLE_PREFIX}project_skills
SET
    disable_model_invocation = COALESCE((metadata->>'disableModelInvocation')::boolean, FALSE),
    user_invocable = COALESCE((metadata->>'userInvocable')::boolean, TRUE);

-- Drop metadata column
ALTER TABLE ${TABLE_PREFIX}project_skills
DROP COLUMN IF EXISTS metadata;
