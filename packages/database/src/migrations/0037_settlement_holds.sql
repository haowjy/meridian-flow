CREATE TABLE "branch_push_settlement_holds" (
	"batch_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"document_id" uuid,
	"reason" jsonb NOT NULL,
	"decided_in" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_holds_batch_id_item_key_pk" PRIMARY KEY("batch_id","item_key"),
	CONSTRAINT "branch_push_settlement_holds_decided_in_valid" CHECK ("branch_push_settlement_holds"."decided_in" IN ('check', 'completion'))
);
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_holds" ADD CONSTRAINT "branch_push_settlement_holds_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;