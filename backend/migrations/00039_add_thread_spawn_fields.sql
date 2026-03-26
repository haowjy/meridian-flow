-- +goose Up
-- +goose ENVSUB ON
-- Add spawn fields to threads for subagent spawning (SP1).
-- parent_thread_id links child to parent, spawn_status tracks lifecycle,
-- spawn_result stores JSONB outcome, spawn_depth is denormalized for O(1) limit checks.

ALTER TABLE ${TABLE_PREFIX}threads
    ADD COLUMN parent_thread_id UUID REFERENCES ${TABLE_PREFIX}threads(id) ON DELETE SET NULL,
    ADD COLUMN spawn_status TEXT,
    ADD COLUMN spawn_result JSONB,
    ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;

-- Prevent self-referential spawns: a thread cannot be its own parent.
ALTER TABLE ${TABLE_PREFIX}threads
    ADD CONSTRAINT ${TABLE_PREFIX}threads_no_self_parent
    CHECK (parent_thread_id IS NULL OR parent_thread_id != id);

-- Constrain spawn_status to valid values (NULL for non-spawn threads).
ALTER TABLE ${TABLE_PREFIX}threads
    ADD CONSTRAINT ${TABLE_PREFIX}threads_spawn_status_check
    CHECK (spawn_status IS NULL OR spawn_status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out'));

-- spawn_depth must be non-negative.
ALTER TABLE ${TABLE_PREFIX}threads
    ADD CONSTRAINT ${TABLE_PREFIX}threads_spawn_depth_check
    CHECK (spawn_depth >= 0);

-- Index for listing child threads of a parent (e.g., GET /api/threads/{id}/spawns).
CREATE INDEX idx_${TABLE_PREFIX}threads_parent
    ON ${TABLE_PREFIX}threads(parent_thread_id, created_at DESC)
    WHERE deleted_at IS NULL AND parent_thread_id IS NOT NULL;

-- +goose Down
-- +goose ENVSUB ON
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}threads_parent;
ALTER TABLE ${TABLE_PREFIX}threads DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}threads_spawn_depth_check;
ALTER TABLE ${TABLE_PREFIX}threads DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}threads_spawn_status_check;
ALTER TABLE ${TABLE_PREFIX}threads DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}threads_no_self_parent;
ALTER TABLE ${TABLE_PREFIX}threads
    DROP COLUMN IF EXISTS spawn_depth,
    DROP COLUMN IF EXISTS spawn_result,
    DROP COLUMN IF EXISTS spawn_status,
    DROP COLUMN IF EXISTS parent_thread_id;
