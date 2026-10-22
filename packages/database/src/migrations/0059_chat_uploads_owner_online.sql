-- migration: no-transaction
-- Online half of 0058_chat_uploads_owner. Re-runnable.
-- The project-source unique index must exclude chat sources (slug `uploads`), so it is rebuilt: the
-- replacement is valid before the old one goes, so uniqueness is never unguarded.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "context_sources_project_scope_slug_v2" ON "context_sources" USING btree ("project_id","slug") WHERE "work_id" IS NULL AND "root_thread_id" IS NULL AND "chat_thread_id" IS NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "context_sources_project_scope_slug";
--> statement-breakpoint
ALTER INDEX IF EXISTS "context_sources_project_scope_slug_v2" RENAME TO "context_sources_project_scope_slug"; -- migration-lint: skip RENAME_INDEX
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "context_sources_chat_slug" ON "context_sources" USING btree ("chat_thread_id","slug") WHERE "chat_thread_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "upload_intakes_owner_thread" ON "upload_intakes" USING btree ("owner_thread_id") WHERE "owner_thread_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_sources" VALIDATE CONSTRAINT "context_sources_exactly_one_scope";
--> statement-breakpoint
ALTER TABLE "context_sources" VALIDATE CONSTRAINT "context_sources_scope_valid";
