CREATE TABLE "model_response_causal_cuts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"admitted_through" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_response_causal_cuts_response_document_unique" UNIQUE("response_id","document_id"),
	CONSTRAINT "model_response_causal_cuts_generation_positive" CHECK ("model_response_causal_cuts"."generation" > 0),
	CONSTRAINT "model_response_causal_cuts_admitted_through_nonnegative" CHECK ("model_response_causal_cuts"."admitted_through" >= 0)
);
--> statement-breakpoint
ALTER TABLE "model_response_causal_cuts" ADD CONSTRAINT "model_response_causal_cuts_response_id_model_response_observation_snapshots_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."model_response_observation_snapshots"("response_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_response_causal_cuts" ADD CONSTRAINT "model_response_causal_cuts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_response_causal_cuts_document_idx" ON "model_response_causal_cuts" USING btree ("document_id");