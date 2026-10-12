-- migration: no-transaction
DROP INDEX CONCURRENTLY IF EXISTS "upload_intakes_source_path_live";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "upload_intakes_source_path_live" ON "upload_intakes" USING btree ("context_source_id","final_path") WHERE "upload_intakes"."state" <> 'deleted';
