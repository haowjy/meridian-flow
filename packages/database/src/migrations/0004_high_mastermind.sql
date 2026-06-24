DROP INDEX "document_yjs_reversals_document_thread_turn";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD COLUMN "write_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD COLUMN "write_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","write_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_reversals_document_thread_write" ON "document_yjs_reversals" USING btree ("document_id","thread_id","write_id");