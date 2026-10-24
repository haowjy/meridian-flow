-- migration: no-transaction
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "content_purged_at" timestamp with time zone;
--> statement-breakpoint
SET lock_timeout = '0';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_purge_candidates" ON "documents" USING btree ("deleted_at","id") WHERE "documents"."content_purged_at" IS NULL AND "documents"."deleted_at" IS NOT NULL AND "documents"."deletion_reason" = 'deleted' AND NOT "documents"."hidden" AND "documents"."deleted_by_work_id" IS NULL;
