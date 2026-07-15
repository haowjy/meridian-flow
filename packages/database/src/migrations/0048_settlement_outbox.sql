CREATE TABLE "branch_push_settlement_outbox" (
	"push_id" bigint PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"state" text DEFAULT 'pending_live_settlement' NOT NULL,
	"document_title" text NOT NULL,
	"baseline_state" "bytea" NOT NULL,
	"push_update" "bytea" NOT NULL,
	"deleted_parent_identities" jsonb NOT NULL,
	"before_content_ref" bigint,
	"trail" jsonb NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_outbox_state_valid" CHECK ("branch_push_settlement_outbox"."state" = 'pending_live_settlement')
);
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_push_id_push_lineage_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."push_lineage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_pending" ON "branch_push_settlement_outbox" USING btree ("created_at") WHERE "branch_push_settlement_outbox"."settled_at" IS NULL;--> statement-breakpoint
-- Pre-canonical change details cannot be folded safely because display hashes
-- are presentation values. No production history exists, so reset instead of
-- preserving a dual-key compatibility path.
TRUNCATE TABLE "change_trail_shells" CASCADE;
