ALTER TABLE "document_yjs_drafts" RENAME COLUMN "thread_id" TO "work_id";--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" DROP CONSTRAINT "document_yjs_drafts_thread_id_threads_id_fk";
--> statement-breakpoint
DROP INDEX "document_yjs_drafts_active_document_thread";--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_drafts_active_document_work" ON "document_yjs_drafts" USING btree ("document_id","work_id") WHERE status IN ('active', 'accepting');