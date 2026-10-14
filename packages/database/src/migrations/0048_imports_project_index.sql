-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_project_created" ON "imports" USING btree ("project_id","created_at");
