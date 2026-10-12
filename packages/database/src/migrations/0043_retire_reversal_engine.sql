SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "document_yjs_reversal_ops" CASCADE;--> statement-breakpoint
DROP TABLE "document_yjs_reversals" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP CONSTRAINT "agent_edit_mutations_status_valid";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP CONSTRAINT "document_yjs_updates_reversal_actor_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "agent_edit_mutations_document_thread_write_id";--> statement-breakpoint
DROP INDEX "agent_edit_mutations_thread_status";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "undo_update_seq";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "reversed_at";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" DROP COLUMN "reversed_by";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP COLUMN "reversal_actor_type";--> statement-breakpoint
ALTER TABLE "document_yjs_updates" DROP COLUMN "reversal_actor_user_id";