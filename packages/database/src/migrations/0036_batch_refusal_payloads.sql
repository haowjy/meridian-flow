CREATE TABLE "branch_push_settlement_payloads" (
	"batch_id" uuid NOT NULL,
	"step_kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "branch_push_settlement_payloads_batch_id_step_kind_pk" PRIMARY KEY("batch_id","step_kind")
);
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_batches" DROP CONSTRAINT "branch_push_settlement_batches_state_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_batches" DROP CONSTRAINT "branch_push_settlement_batches_terminal_shape";--> statement-breakpoint
DROP INDEX "branch_push_settlement_batches_unresolved";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_batches" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_payloads" ADD CONSTRAINT "branch_push_settlement_payloads_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_push_settlement_batches_unresolved" ON "branch_push_settlement_batches" USING btree ("id") WHERE "branch_push_settlement_batches"."state" IN ('pending', 'blocked');--> statement-breakpoint
ALTER TABLE "branch_push_settlement_batches" ADD CONSTRAINT "branch_push_settlement_batches_state_valid" CHECK ("branch_push_settlement_batches"."state" IN ('pending', 'blocked', 'completed', 'abandoned'));--> statement-breakpoint
ALTER TABLE "branch_push_settlement_batches" ADD CONSTRAINT "branch_push_settlement_batches_terminal_shape" CHECK ((
        ("branch_push_settlement_batches"."state" = 'completed' AND "branch_push_settlement_batches"."completed_at" IS NOT NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'blocked' AND "branch_push_settlement_batches"."blocked_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'abandoned' AND "branch_push_settlement_batches"."abandoned_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'pending' AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL)
      ));