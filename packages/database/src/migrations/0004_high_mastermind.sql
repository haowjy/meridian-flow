DROP INDEX "document_yjs_reversals_document_thread_turn";--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD COLUMN "write_id" text;--> statement-breakpoint
UPDATE "agent_edit_mutations" SET "write_id" = 'w' || "w_id"::text WHERE "write_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ALTER COLUMN "write_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD COLUMN "write_id" text;--> statement-breakpoint
UPDATE "document_yjs_reversals" SET "write_id" = "turn_id"::text WHERE "write_id" IS NULL;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ALTER COLUMN "write_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","write_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_reversals_document_thread_write" ON "document_yjs_reversals" USING btree ("document_id","thread_id","write_id");
