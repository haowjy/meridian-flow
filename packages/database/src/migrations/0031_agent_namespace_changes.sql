CREATE TABLE "agent_namespace_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"w_id" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"response_id" uuid,
	"kind" text NOT NULL,
	"from_uri" text NOT NULL,
	"to_uri" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "agent_namespace_changes_kind_valid" CHECK ("agent_namespace_changes"."kind" IN ('move', 'delete')),
	CONSTRAINT "agent_namespace_changes_move_target" CHECK (("agent_namespace_changes"."kind" = 'move') = ("agent_namespace_changes"."to_uri" IS NOT NULL)),
	CONSTRAINT "agent_namespace_changes_status_valid" CHECK ("agent_namespace_changes"."status" IN ('active', 'reversed'))
);
--> statement-breakpoint
ALTER TABLE "agent_namespace_changes" ADD CONSTRAINT "agent_namespace_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_namespace_changes" ADD CONSTRAINT "agent_namespace_changes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_namespace_changes" ADD CONSTRAINT "agent_namespace_changes_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_namespace_changes" ADD CONSTRAINT "agent_namespace_changes_response_id_model_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."model_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_namespace_changes_document_thread_w_id" ON "agent_namespace_changes" USING btree ("document_id","thread_id","w_id");--> statement-breakpoint
CREATE INDEX "agent_namespace_changes_thread_turn" ON "agent_namespace_changes" USING btree ("thread_id","turn_id");