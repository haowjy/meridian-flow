-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_order" ON "import_entries" USING btree ("import_id","ordinal");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_version" ON "import_entries" USING btree ("import_id","version");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_object_sweep" ON "import_entries" USING btree ("lease_until") WHERE "import_entries"."attempt_id" IS NOT NULL AND "import_entries"."state" IN ('deleted','not_imported') AND "import_entries"."kind" = 'binary';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_project_created" ON "imports" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "link_ahead_refs_awaited_document" ON "link_ahead_refs" USING btree ("awaited_document_id") WHERE "link_ahead_refs"."awaited_document_id" IS NOT NULL AND "link_ahead_refs"."settled_document_id" IS NULL;
--> statement-breakpoint
-- Build the case-sensitive guard under its permanent name while the old lower() guard still protects uploads.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "upload_intakes_source_path_exact_live" ON "upload_intakes" USING btree ("context_source_id","final_path") WHERE "upload_intakes"."state" <> 'deleted';
--> statement-breakpoint
ALTER TABLE "import_entries" VALIDATE CONSTRAINT "import_entries_import_id_imports_id_fk";
--> statement-breakpoint
ALTER TABLE "import_progress" VALIDATE CONSTRAINT "import_progress_import_id_imports_id_fk";
--> statement-breakpoint
ALTER TABLE "imports" VALIDATE CONSTRAINT "imports_project_id_projects_id_fk";
--> statement-breakpoint
-- Last: the old guard goes only once the replacement is valid, so a failed run or retry never leaves uploads unguarded.
DROP INDEX CONCURRENTLY IF EXISTS "upload_intakes_source_path_live";
