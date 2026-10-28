-- migration: no-transaction
-- Subagent asks: the asked outcome and spawn status, the forwarded-ask relay record, each ask's
-- continuation state and admitted turn, and the withdrawn-notice fence on execution reports.
-- Checks are added NOT VALID, then validated, so no ACCESS EXCLUSIVE lock is held through
-- validation; the index is built concurrently.
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
ALTER TABLE "asks" ADD COLUMN IF NOT EXISTS "continuation" text;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN IF NOT EXISTS "continuation_turn_id" uuid;
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD COLUMN IF NOT EXISTS "notice_withdrawn" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
-- A resolved ask whose ask_resolved row is still waiting has a continuation owed; every other
-- resolved ask already continued, or was cancelled.
UPDATE "asks" SET "continuation" = CASE
  WHEN "status" = 'cancelled' THEN 'cancelled'
  WHEN EXISTS (
    SELECT 1 FROM thread_inbox_messages inbox
    WHERE inbox.thread_id = "asks"."thread_id"
      AND inbox.delivered_at IS NULL
      AND inbox.body->>'kind' = 'ask_resolved'
      AND inbox.body->>'askId' = "asks"."id"::text
  ) THEN 'pending'
  ELSE 'done'
END
WHERE "status" IN ('answered', 'expired', 'cancelled') AND "continuation" IS NULL;
--> statement-breakpoint
SET lock_timeout = '2s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'asks'::regclass AND conname = 'asks_continuation_valid'
  ) THEN
    ALTER TABLE asks ADD CONSTRAINT asks_continuation_valid CHECK (("status" IN ('pending', 'open') AND "continuation" IS NULL) OR ("status" IN ('answered', 'expired') AND "continuation" IN ('pending', 'admitted', 'done', 'cancelled')) OR ("status" = 'cancelled' AND "continuation" = 'cancelled')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
ALTER TABLE asks VALIDATE CONSTRAINT asks_continuation_valid;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "asks_held_by_thread"
  ON "asks" ("thread_id")
  WHERE "status" IN ('pending', 'open') OR "continuation" IN ('pending', 'admitted');
