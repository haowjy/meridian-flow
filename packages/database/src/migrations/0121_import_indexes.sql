-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_order" ON "import_entries" USING btree ("import_id","ordinal");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_state" ON "import_entries" USING btree ("import_id","state");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_project_created" ON "imports" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_user_open" ON "imports" USING btree ("user_id") WHERE "imports"."acknowledged_at" IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_organize_claim" ON "imports" USING btree ("state","lease_until") WHERE "imports"."state" = 'organizing';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_upload_expiry" ON "imports" USING btree ("last_activity_at") WHERE "imports"."state" = 'uploading';
--> statement-breakpoint
ALTER TABLE "import_entries" VALIDATE CONSTRAINT "import_entries_import_id_imports_id_fk";
--> statement-breakpoint
ALTER TABLE "imports" VALIDATE CONSTRAINT "imports_project_id_projects_id_fk";
--> statement-breakpoint
-- Document names decide an upload's name, so no index on the intake's final_path replaces this one.
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "upload_intakes_source_path_live";
