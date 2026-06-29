ALTER TABLE "document_yjs_drafts" DROP CONSTRAINT "document_yjs_drafts_status_valid";--> statement-breakpoint
DROP INDEX "document_yjs_drafts_active_document_thread";--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_drafts_active_document_thread" ON "document_yjs_drafts" USING btree ("document_id","thread_id") WHERE status IN ('active', 'accepting');--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_status_valid" CHECK ("document_yjs_drafts"."status" IN ('active', 'accepting', 'applied', 'discarded'));