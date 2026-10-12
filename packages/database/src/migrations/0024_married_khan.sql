ALTER TABLE "threads" DROP CONSTRAINT "threads_spawn_root_required";--> statement-breakpoint
DROP INDEX "turns_pending_placeholders";--> statement-breakpoint
UPDATE "threads" SET "root_thread_id" = "id" WHERE "root_thread_id" IS NULL;--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "root_thread_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (the statement above backfills NULL roots to each primary thread's own id)--> statement-breakpoint
CREATE INDEX "threads_lineage_derivations" ON "threads" USING btree ("root_thread_id") WHERE "threads"."origin_type" IN ('fork', 'handoff'); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-launch threads has no deployed rows; Drizzle runs migrations transactionally, so CONCURRENTLY is unavailable)--> statement-breakpoint
CREATE INDEX "turns_pending_placeholders" ON "turns" USING btree ("id") WHERE "turns"."status" = 'pending' AND "turns"."role" IN ('compaction', 'system'); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-launch turns has no deployed rows; Drizzle runs migrations transactionally, so CONCURRENTLY is unavailable)--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_handoff_origin_turn_required" CHECK ("threads"."origin_type" <> 'handoff' OR "threads"."origin_turn_id" IS NOT NULL);
