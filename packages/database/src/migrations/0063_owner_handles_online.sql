-- migration: no-transaction
-- Online half of 0062_owner_handles. Re-runnable.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "works_project_handle" ON "works" USING btree ("project_id","handle") WHERE "handle" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_no_work_handle";
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_handle_valid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "works_project_slug";
--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN IF EXISTS "slug"; -- migration-lint: skip DROP_COLUMN (0062 copied every slug into a handle and nothing reads it)
--> statement-breakpoint
DROP TABLE IF EXISTS "project_thread_counters"; -- migration-lint: skip DROP_TABLE (0062 copied every counter into project_handle_counters)
