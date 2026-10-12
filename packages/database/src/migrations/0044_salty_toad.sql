-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "import_entries_import_version" ON "import_entries" USING btree ("import_id","version");