-- migration: no-transaction
-- Online half of 0060_chat_uploads_reset. Re-runnable.
-- The unsettled-ref index keys the chat owner too, so it is rebuilt: the replacement exists before the old one goes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "link_ahead_refs_owner_unsettled_v2" ON "link_ahead_refs" USING btree ("project_id","scheme","work_id","root_thread_id","chat_thread_id",md5("path")) WHERE "settled_document_id" IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "link_ahead_refs_owner_unsettled";
--> statement-breakpoint
ALTER INDEX IF EXISTS "link_ahead_refs_owner_unsettled_v2" RENAME TO "link_ahead_refs_owner_unsettled"; -- migration-lint: skip RENAME_INDEX
--> statement-breakpoint
ALTER TABLE "context_sources" VALIDATE CONSTRAINT "context_sources_uploads_chat_only";
--> statement-breakpoint
ALTER TABLE "upload_intakes" VALIDATE CONSTRAINT "upload_intakes_owner_required";
--> statement-breakpoint
-- Postgres takes the validated check as proof and skips the scan.
ALTER TABLE "upload_intakes" ALTER COLUMN "owner_thread_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP CONSTRAINT IF EXISTS "upload_intakes_owner_required";
