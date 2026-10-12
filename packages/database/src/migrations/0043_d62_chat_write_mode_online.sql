-- migration: no-transaction
-- Online half of 0042_d62_chat_write_mode: validate the CHECKs it added NOT VALID, and build the index
-- that finds an execution's turns (its end and stale-row settlement read it). Re-runnable.
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_ai_write_mode_valid";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_body_valid";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "turns_execution" ON "turns" USING btree ("thread_id","execution_id") WHERE "turns"."execution_id" IS NOT NULL;
