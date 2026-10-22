-- migration: no-transaction
-- Online half of 0085 and 0086: each statement re-runnable and outside any DDL transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_deleted_by_thread_idx" ON "documents" USING btree ("deleted_by_thread_id") WHERE "documents"."deleted_by_thread_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_deleted_by_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_tree_change_valid";
