CREATE TABLE "agent_edit_sync_state" (
  "document_id" uuid NOT NULL,
  "thread_id" uuid NOT NULL,
  "state_vector" bytea NOT NULL,
  "synced_snapshot" bytea NOT NULL,
  "committed_snapshot" bytea NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_edit_sync_state_document_id_thread_id_pk" PRIMARY KEY("document_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "agent_edit_sync_state" ADD CONSTRAINT "agent_edit_sync_state_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_edit_sync_state" ADD CONSTRAINT "agent_edit_sync_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
