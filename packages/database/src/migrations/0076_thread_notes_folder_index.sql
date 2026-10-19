-- migration: no-transaction
-- Live associations are unique; tombstones keep their historical association.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "folders_source_thread_live" ON "folders" USING btree ("context_source_id","thread_id") WHERE "thread_id" IS NOT NULL AND "deleted_at" IS NULL AND NOT "hidden";
