DROP INDEX "document_yjs_reversal_ops_document_thread_handle";--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD COLUMN "scope_id" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" DROP CONSTRAINT "document_yjs_reversal_ops_document_id_thread_id_update_seq_handle_pk";--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_document_id_thread_id_scope_id_update_seq_handle_pk" PRIMARY KEY("document_id","thread_id","scope_id","update_seq","handle");--> statement-breakpoint
CREATE INDEX "document_yjs_reversal_ops_document_thread_handle" ON "document_yjs_reversal_ops" USING btree ("document_id","thread_id","scope_id","handle");
