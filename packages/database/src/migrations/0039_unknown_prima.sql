CREATE TABLE "pending_notice_deliveries" (
	"notice_id" bigint NOT NULL,
	"thread_id" uuid NOT NULL,
	"document_id" uuid,
	CONSTRAINT "pending_notice_deliveries_notice_id_thread_id_pk" PRIMARY KEY("notice_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "pending_notices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"writer_document_id" uuid,
	"message" text NOT NULL,
	"data" jsonb NOT NULL,
	"writer_visible" boolean DEFAULT false NOT NULL,
	"writer_consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_notices_scope_valid" CHECK ("pending_notices"."scope_kind" IN ('thread', 'document'))
);
--> statement-breakpoint
ALTER TABLE "pending_notice_deliveries" ADD CONSTRAINT "pending_notice_deliveries_notice_id_pending_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."pending_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notice_deliveries" ADD CONSTRAINT "pending_notice_deliveries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notice_deliveries" ADD CONSTRAINT "pending_notice_deliveries_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notices" ADD CONSTRAINT "pending_notices_writer_document_id_documents_id_fk" FOREIGN KEY ("writer_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_notice_deliveries_thread" ON "pending_notice_deliveries" USING btree ("thread_id","document_id");--> statement-breakpoint
CREATE INDEX "pending_notices_writer" ON "pending_notices" USING btree ("writer_document_id","writer_consumed");