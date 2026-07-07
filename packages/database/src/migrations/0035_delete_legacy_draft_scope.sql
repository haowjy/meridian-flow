DROP TABLE IF EXISTS "document_yjs_draft_updates" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "document_yjs_drafts" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "agent_edit_mutations_document_thread_write_id";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_edit_mutations_document_thread_w_id";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_edit_mutations_thread_status";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_edit_mutations_turn";--> statement-breakpoint
DROP INDEX IF EXISTS "document_yjs_reversals_document_thread_write";--> statement-breakpoint
DROP INDEX IF EXISTS "document_yjs_reversals_document_thread";--> statement-breakpoint
DROP INDEX IF EXISTS "document_yjs_reversal_ops_document_thread_handle";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN IF EXISTS "scope_id";--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" DROP CONSTRAINT IF EXISTS "agent_edit_wid_counters_document_id_thread_id_scope_id_pk";--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" DROP COLUMN IF EXISTS "scope_id";--> statement-breakpoint
ALTER TABLE "agent_edit_wid_counters" ADD CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_pk" PRIMARY KEY("document_id", "thread_id");--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" DROP COLUMN IF EXISTS "scope_id";--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" DROP CONSTRAINT IF EXISTS "document_yjs_reversal_ops_document_id_thread_id_scope_id_update_seq_handle_pk";--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" DROP COLUMN IF EXISTS "scope_id";--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_document_id_thread_id_update_seq_handle_pk" PRIMARY KEY("document_id", "thread_id", "update_seq", "handle");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id" ON "agent_edit_mutations" USING btree ("document_id", "thread_id", "write_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_w_id" ON "agent_edit_mutations" USING btree ("document_id", "thread_id", "w_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_thread_status" ON "agent_edit_mutations" USING btree ("document_id", "thread_id", "status");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_turn" ON "agent_edit_mutations" USING btree ("document_id", "thread_id", "turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_reversals_document_thread_write" ON "document_yjs_reversals" USING btree ("document_id", "thread_id", "write_id");--> statement-breakpoint
CREATE INDEX "document_yjs_reversals_document_thread" ON "document_yjs_reversals" USING btree ("document_id", "thread_id");--> statement-breakpoint
CREATE INDEX "document_yjs_reversal_ops_document_thread_handle" ON "document_yjs_reversal_ops" USING btree ("document_id", "thread_id", "handle");
