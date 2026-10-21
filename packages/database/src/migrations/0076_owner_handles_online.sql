-- migration: no-transaction
-- Online half of 0075_owner_handles. Re-runnable.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "works_project_handle" ON "works" USING btree ("project_id","handle") WHERE "handle" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_no_work_handle";
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_handle_valid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "works_project_slug";
--> statement-breakpoint
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN IF EXISTS "slug"; -- migration-lint: skip DROP_COLUMN (0075 assigned every named Work a permanent handle; names and owner IDs are preserved and no reader uses slug)
--> statement-breakpoint
DROP TABLE IF EXISTS "project_thread_counters"; -- migration-lint: skip DROP_TABLE (0075 copied every counter into project_handle_counters)

--> statement-breakpoint
RESET lock_timeout;
