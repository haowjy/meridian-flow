-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_order" ON "import_entries" USING btree ("import_id","ordinal");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_version" ON "import_entries" USING btree ("import_id","version");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_object_sweep" ON "import_entries" USING btree ("lease_until") WHERE "import_entries"."attempt_id" IS NOT NULL AND "import_entries"."state" IN ('deleted','not_imported') AND "import_entries"."spec"->>'kind' = 'binary';
