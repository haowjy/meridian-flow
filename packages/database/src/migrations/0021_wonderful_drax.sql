ALTER TABLE "thread_inbox_messages" ADD COLUMN "runs_first" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP INDEX "turns_pending_placeholders";--> statement-breakpoint
CREATE INDEX "turns_pending_placeholders" ON "turns" USING btree ("id") WHERE "turns"."status" = 'pending' AND "turns"."role" IN ('compaction', 'system'); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-launch turns has no deployed rows; Drizzle runs migrations transactionally, so CONCURRENTLY is unavailable)--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_handoff_origin_turn_required" CHECK ("threads"."origin_type" <> 'handoff' OR "threads"."origin_turn_id" IS NOT NULL);
