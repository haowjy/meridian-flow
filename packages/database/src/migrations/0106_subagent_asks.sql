-- migration: no-transaction
-- Subagent asks: the asked outcome and spawn status, the forwarded-ask relay record, and the
-- continuation ask on execution reports. Checks are swapped NOT VALID, then validated, so no
-- ACCESS EXCLUSIVE lock is held through validation; the index is built concurrently.
SET lock_timeout = '2s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
  ) THEN
    ALTER TABLE thread_execution_reports ADD CONSTRAINT thread_execution_reports_outcome_valid_v2
      CHECK (outcome IS NULL OR outcome IN ('succeeded','asked','failed','cancelled')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE thread_execution_reports VALIDATE CONSTRAINT thread_execution_reports_outcome_valid_v2;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_execution_reports'::regclass
      AND conname = 'thread_execution_reports_outcome_valid_v2'
  ) THEN
    ALTER TABLE thread_execution_reports DROP CONSTRAINT IF EXISTS thread_execution_reports_outcome_valid;
    ALTER TABLE thread_execution_reports RENAME CONSTRAINT thread_execution_reports_outcome_valid_v2 TO thread_execution_reports_outcome_valid;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'threads'::regclass
      AND conname = 'threads_spawn_status_valid_v2'
  ) THEN
    ALTER TABLE threads ADD CONSTRAINT threads_spawn_status_valid_v2
      CHECK (spawn_status IS NULL OR spawn_status IN ('running', 'asked', 'succeeded', 'failed', 'cancelled')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'threads'::regclass
      AND conname = 'threads_spawn_status_valid_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE threads VALIDATE CONSTRAINT threads_spawn_status_valid_v2;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'threads'::regclass
      AND conname = 'threads_spawn_status_valid_v2'
  ) THEN
    ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_spawn_status_valid;
    ALTER TABLE threads RENAME CONSTRAINT threads_spawn_status_valid_v2 TO threads_spawn_status_valid;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN IF NOT EXISTS "relay" jsonb;
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD COLUMN IF NOT EXISTS "continuation_ask_id" uuid;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
-- Not unique: a forwarded parent that crashed mid-relay reruns its continuation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "thread_execution_reports_continuation_ask"
  ON "thread_execution_reports" ("continuation_ask_id")
  WHERE "continuation_ask_id" IS NOT NULL;
