ALTER TABLE "pending_notices" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
UPDATE "pending_notices" AS "notice"
SET "thread_id" = "notice"."scope_id"
FROM "threads"
WHERE "notice"."scope_kind" = 'thread'
	AND "threads"."id" = "notice"."scope_id";--> statement-breakpoint
-- Document-scoped notices belonged to the removed sweep fan-out and have no
-- single target thread. Dangling thread scopes likewise have no recipient.
-- Delete those pre-release queue entries deliberately, losing their message and data.
DELETE FROM "pending_notices"
WHERE "thread_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pending_notices" ALTER COLUMN "thread_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (recoverable rows are backfilled and all recipient-less rows are deleted above)--> statement-breakpoint
ALTER TABLE "pending_notices" ADD CONSTRAINT "pending_notices_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "pending_notices" VALIDATE CONSTRAINT "pending_notices_thread_id_threads_id_fk";--> statement-breakpoint
CREATE INDEX "pending_notices_thread" ON "pending_notices" USING btree ("thread_id","created_at","id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release queue migration)--> statement-breakpoint
ALTER TABLE "pending_notice_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "pending_notice_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "pending_notices" DROP CONSTRAINT "pending_notices_scope_valid";--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "scope_kind"; -- migration-lint: skip DROP_COLUMN (replaced by required thread ownership above)--> statement-breakpoint
ALTER TABLE "pending_notices" DROP COLUMN "scope_id"; -- migration-lint: skip DROP_COLUMN (recoverable thread ownership is backfilled above)
