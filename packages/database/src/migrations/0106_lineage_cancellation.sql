-- migration: no-transaction
-- Lineage cancellation, expand step: each ask's continuation state and admitted turn, the
-- withdrawn-notice fence on execution reports, and the machine-wake fence on threads. The check
-- that ties `continuation` to `status` is 0107's: a server from before this migration still
-- resolves asks with `continuation` NULL while the rollout runs. The index is built concurrently.
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD COLUMN IF NOT EXISTS "notice_withdrawn" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "wake_fence_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN IF NOT EXISTS "continuation" text;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN IF NOT EXISTS "continuation_turn_id" uuid;
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
CREATE INDEX CONCURRENTLY IF NOT EXISTS "asks_held_by_thread"
  ON "asks" ("thread_id")
  WHERE "status" IN ('pending', 'open') OR "continuation" = 'pending';
