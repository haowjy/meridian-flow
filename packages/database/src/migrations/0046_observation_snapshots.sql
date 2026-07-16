CREATE TABLE "model_response_observation_entries" (
	"response_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"client_id" bigint NOT NULL,
	"clock" bigint NOT NULL,
	"kind" text NOT NULL,
	"content_digest" text,
	"captured_deleted_body" text,
	CONSTRAINT "model_response_observation_entries_pk" PRIMARY KEY("response_id","document_id","client_id","clock"),
	CONSTRAINT "model_response_observation_entries_client_id_nonneg" CHECK ("model_response_observation_entries"."client_id" >= 0),
	CONSTRAINT "model_response_observation_entries_clock_nonneg" CHECK ("model_response_observation_entries"."clock" >= 0),
	CONSTRAINT "model_response_observation_entries_value_valid" CHECK (("model_response_observation_entries"."kind" = 'rendered' AND "model_response_observation_entries"."content_digest" IS NOT NULL AND "model_response_observation_entries"."captured_deleted_body" IS NULL) OR ("model_response_observation_entries"."kind" = 'explicit_deletion' AND "model_response_observation_entries"."content_digest" IS NULL AND "model_response_observation_entries"."captured_deleted_body" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "model_response_observation_snapshots" (
	"response_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD COLUMN "authoring_response_id" uuid;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD COLUMN "authoring_response_id" uuid;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD COLUMN "authoring_response_id" uuid;--> statement-breakpoint
ALTER TABLE "model_response_observation_entries" ADD CONSTRAINT "model_response_observation_entries_response_id_model_response_observation_snapshots_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."model_response_observation_snapshots"("response_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_response_observation_entries" ADD CONSTRAINT "model_response_observation_entries_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_response_observation_snapshots" ADD CONSTRAINT "model_response_observation_snapshots_response_id_model_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."model_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_response_observation_entries_document_idx" ON "model_response_observation_entries" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
