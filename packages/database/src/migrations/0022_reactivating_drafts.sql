ALTER TABLE "document_yjs_drafts" DROP CONSTRAINT "document_yjs_drafts_status_valid";--> statement-breakpoint
DROP INDEX "document_yjs_drafts_active_document_work";--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_drafts_active_document_work"
  ON "document_yjs_drafts" USING btree ("document_id", "work_id")
  WHERE status IN ('active', 'accepting', 'reactivating');--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_status_valid"
  CHECK ("document_yjs_drafts"."status" IN ('active', 'accepting', 'reactivating', 'applied', 'discarded'));
