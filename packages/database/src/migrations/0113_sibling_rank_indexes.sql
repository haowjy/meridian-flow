-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folders_sibling_rank_live" ON "folders" USING btree ("context_source_id","parent_id",("rank" COLLATE "C"),"id") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden" AND "folders"."rank" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_sibling_rank_live" ON "documents" USING btree ("context_source_id","folder_id",("rank" COLLATE "C"),"id") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."rank" IS NOT NULL;
