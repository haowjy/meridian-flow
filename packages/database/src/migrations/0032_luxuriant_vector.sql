ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_exactly_one_scope";--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_valid";--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_work_fk";--> statement-breakpoint
DROP INDEX "context_sources_project_slug";--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "root_thread_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_lineage_slug" ON "context_sources" USING btree ("root_thread_id","slug") WHERE "context_sources"."root_thread_id" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-launch tables have no deployed rows; Drizzle runs migrations transactionally, so CONCURRENTLY is unavailable)--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."deleted_at" IS NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-launch tables have no deployed rows; Drizzle runs migrations transactionally, so CONCURRENTLY is unavailable)--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."scope" = 'project' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL) OR ("context_sources"."scope" = 'work' AND "context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL AND "context_sources"."root_thread_id" IS NULL) OR ("context_sources"."scope" = 'lineage' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NOT NULL AND "context_sources"."slug" = 'scratch'));--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work', 'lineage'));--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_work_fk" CHECK ("context_sources"."scope" <> 'work' OR "context_sources"."work_id" IS NOT NULL);
--> statement-breakpoint
-- No Work keeps Uploads, but no longer owns Scratch. No user data is migrated.
DELETE FROM context_sources s USING works w
WHERE s.work_id = w.id AND w.is_no_work AND s.slug = 'scratch';
