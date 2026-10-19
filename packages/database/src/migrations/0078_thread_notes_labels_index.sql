-- migration: no-transaction
-- Title publication finds only the affected associated roots, not every source.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folders_thread_live" ON "folders" USING btree ("thread_id") WHERE "folders"."thread_id" IS NOT NULL AND "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";
