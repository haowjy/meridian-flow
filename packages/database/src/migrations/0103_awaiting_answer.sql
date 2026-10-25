-- migration: no-transaction
-- Replace the parked-turn status without leaving turns unreadable during rollout.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE turns ADD CONSTRAINT turns_status_transition_valid CHECK (status IN ('pending', 'streaming', 'waiting_interrupt', 'awaiting_answer', 'complete', 'cancelled', 'error')) NOT VALID;
--> statement-breakpoint
ALTER TABLE turns DROP CONSTRAINT turns_status_valid;
--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS turns_unsettled_v2 ON turns USING btree (thread_id, position) WHERE status IN ('pending', 'streaming', 'awaiting_answer');
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE rename_waiting_interrupt_turns(batch_size int) LANGUAGE plpgsql AS $$
DECLARE batch_ids uuid[];
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    SELECT array_agg(id) INTO batch_ids FROM (
      SELECT id FROM turns WHERE status = 'waiting_interrupt' ORDER BY id LIMIT batch_size FOR UPDATE SKIP LOCKED
    ) page;
    EXIT WHEN batch_ids IS NULL;
    UPDATE turns SET status = 'awaiting_answer' WHERE id = ANY(batch_ids);
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL rename_waiting_interrupt_turns(500);
--> statement-breakpoint
DROP PROCEDURE rename_waiting_interrupt_turns(int);
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE turns ADD CONSTRAINT turns_status_valid_v2 CHECK (status IN ('pending', 'streaming', 'awaiting_answer', 'complete', 'cancelled', 'error')) NOT VALID;
--> statement-breakpoint
ALTER TABLE turns VALIDATE CONSTRAINT turns_status_valid_v2;
--> statement-breakpoint
ALTER TABLE turns DROP CONSTRAINT turns_status_transition_valid;
--> statement-breakpoint
ALTER TABLE turns RENAME CONSTRAINT turns_status_valid_v2 TO turns_status_valid;
--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS turns_unsettled;
--> statement-breakpoint
ALTER INDEX turns_unsettled_v2 RENAME TO turns_unsettled;
--> statement-breakpoint
DROP TABLE project_user_preferences;
