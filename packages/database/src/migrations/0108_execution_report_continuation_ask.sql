-- migration: no-transaction
ALTER TABLE "thread_execution_reports"
  ADD COLUMN IF NOT EXISTS "continuation_ask_id" uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "thread_execution_reports_continuation_ask"
  ON "thread_execution_reports" ("continuation_ask_id")
  WHERE "continuation_ask_id" IS NOT NULL;
