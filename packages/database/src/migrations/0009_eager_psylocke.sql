CREATE TABLE "document_yjs_reversal_ops" (
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"update_seq" bigint NOT NULL,
	"handle" text NOT NULL,
	"direction" text NOT NULL,
	CONSTRAINT "document_yjs_reversal_ops_document_id_thread_id_update_seq_handle_pk" PRIMARY KEY("document_id","thread_id","update_seq","handle"),
	CONSTRAINT "document_yjs_reversal_ops_direction_valid" CHECK ("document_yjs_reversal_ops"."direction" IN ('undo', 'redo'))
);
--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_yjs_reversal_ops_document_thread_handle" ON "document_yjs_reversal_ops" USING btree ("document_id","thread_id","handle");