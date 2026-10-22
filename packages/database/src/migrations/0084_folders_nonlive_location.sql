-- migration: no-transaction
-- One location index for every non-live folder a branch's view shows (hidden, or deleted
-- above a document a draft outlived), replacing the hidden-only one. Built online, re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folders_nonlive_location" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE ("folders"."hidden" AND "folders"."deleted_at" IS NULL) OR (NOT "folders"."hidden" AND "folders"."deleted_at" IS NOT NULL);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "folders_hidden_location";
