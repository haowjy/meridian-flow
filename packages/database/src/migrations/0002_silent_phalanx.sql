CREATE TABLE "agent_edit_wid_counters" (
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"next_wid" integer NOT NULL,
	CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_pk" PRIMARY KEY("document_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ALTER COLUMN "created_seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ALTER COLUMN "undo_update_seq" SET DATA TYPE bigint;