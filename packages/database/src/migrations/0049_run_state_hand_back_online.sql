-- migration: no-transaction
-- Online half of 0048_run_state_hand_back: validate the constraints it added NOT VALID, and build the
-- partial index that names a chat's handed-back messages (every conversation read joins it). Re-runnable.
ALTER TABLE "thread_hand_backs" VALIDATE CONSTRAINT "thread_hand_backs_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_handed_back_by_fk";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_hand_back";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "thread_inbox_messages_handed_back" ON "thread_inbox_messages" USING btree ("thread_id") WHERE "thread_inbox_messages"."handed_back_by" IS NOT NULL;
