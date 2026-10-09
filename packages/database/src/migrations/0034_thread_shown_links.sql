CREATE TABLE "thread_shown_links" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"address" text NOT NULL,
	"holder_uri" text NOT NULL,
	"view" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "thread_shown_links_pk" PRIMARY KEY("thread_id","document_id","ref","address","holder_uri","view")
);
--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;