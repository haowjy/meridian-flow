ALTER TABLE "turns" DROP CONSTRAINT "turns_status_valid";--> statement-breakpoint
DROP INDEX "event_journal_thread_id";--> statement-breakpoint
DELETE FROM "event_journal";--> statement-breakpoint
ALTER TABLE "event_journal" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER TABLE "event_journal" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "next_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD COLUMN "status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "actor_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_turn_id_turns_id_fk" FOREIGN KEY ("actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_journal_thread_seq_unique" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "event_journal_thread_seq" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_next_seq_nonneg" CHECK ("threads"."next_seq" >= 0);--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_status_valid" CHECK ("turn_blocks"."status" IN ('complete', 'partial'));--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_block_type_valid" CHECK ("turn_blocks"."block_type" IN ('text', 'image', 'file', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'custom'));--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'waiting_checkpoint', 'complete', 'cancelled', 'error'));
