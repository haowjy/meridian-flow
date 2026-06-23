CREATE TABLE "agent_edit_mutations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"w_id" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_seq" integer NOT NULL,
	"undo_update_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	CONSTRAINT "agent_edit_mutations_status_valid" CHECK ("agent_edit_mutations"."status" IN ('active', 'reversed'))
);
--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_w_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","w_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_thread_status" ON "agent_edit_mutations" USING btree ("document_id","thread_id","status");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_turn" ON "agent_edit_mutations" USING btree ("document_id","thread_id","turn_id");