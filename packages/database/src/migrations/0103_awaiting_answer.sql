-- migration: no-transaction
-- Replace the parked-turn status without leaving turns unreadable during rollout.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'turns'::regclass AND conname = 'turns_status_transition_valid') THEN
    ALTER TABLE turns ADD CONSTRAINT turns_status_transition_valid CHECK (status IN ('pending', 'streaming', 'waiting_interrupt', 'awaiting_answer', 'complete', 'cancelled', 'error')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_status_valid;
--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS turns_unsettled_v2 ON turns USING btree (thread_id, position) WHERE status IN ('pending', 'streaming', 'awaiting_answer');
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE rename_waiting_interrupt_turns(batch_size int) LANGUAGE plpgsql AS $$
DECLARE
  batch_ids uuid[];
  locked_retries int := 0;
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    SELECT array_agg(id) INTO batch_ids FROM (
      SELECT id FROM turns WHERE status = 'waiting_interrupt' ORDER BY id LIMIT batch_size FOR UPDATE SKIP LOCKED
    ) page;
    IF batch_ids IS NULL THEN
      EXIT WHEN NOT EXISTS (SELECT 1 FROM turns WHERE status = 'waiting_interrupt');
      locked_retries := locked_retries + 1;
      IF locked_retries >= 300 THEN
        RAISE EXCEPTION 'waiting_interrupt rows remained locked for 30 seconds';
      END IF;
      PERFORM pg_sleep(0.1);
      CONTINUE;
    END IF;
    locked_retries := 0;
    UPDATE turns SET status = 'awaiting_answer' WHERE id = ANY(batch_ids);
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL rename_waiting_interrupt_turns(500);
--> statement-breakpoint
DROP PROCEDURE IF EXISTS rename_waiting_interrupt_turns(int);
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'turns'::regclass AND conname IN ('turns_status_valid', 'turns_status_valid_v2')) THEN
    ALTER TABLE turns ADD CONSTRAINT turns_status_valid_v2 CHECK (status IN ('pending', 'streaming', 'awaiting_answer', 'complete', 'cancelled', 'error')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'turns'::regclass AND conname = 'turns_status_valid_v2') THEN
    ALTER TABLE turns VALIDATE CONSTRAINT turns_status_valid_v2;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_status_transition_valid;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'turns'::regclass AND conname = 'turns_status_valid_v2')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'turns'::regclass AND conname = 'turns_status_valid') THEN
    ALTER TABLE turns RENAME CONSTRAINT turns_status_valid_v2 TO turns_status_valid;
  END IF;
END $$;
--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS turns_unsettled;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('turns_unsettled_v2') IS NOT NULL AND to_regclass('turns_unsettled') IS NULL THEN
    ALTER INDEX turns_unsettled_v2 RENAME TO turns_unsettled;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS project_user_preferences;
