-- migration: no-transaction
-- Lineage cancellation, contract step: every resolved ask has a continuation state. Asks an
-- older server resolved after 0106 are backfilled again first, then the check is added NOT VALID
-- and validated, so no ACCESS EXCLUSIVE lock is held through validation.
-- As in 0106: a resolved ask whose ask_resolved row is still waiting has a continuation owed;
-- every other resolved ask already continued, or was cancelled.
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
    ALTER TABLE asks ADD CONSTRAINT asks_continuation_valid CHECK (("status" IN ('pending', 'open') AND "continuation" IS NULL) OR ("status" IN ('answered', 'expired') AND "continuation" IN ('pending', 'done', 'cancelled')) OR ("status" = 'cancelled' AND "continuation" = 'cancelled')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
ALTER TABLE asks VALIDATE CONSTRAINT asks_continuation_valid;
