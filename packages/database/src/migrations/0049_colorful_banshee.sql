ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_state_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "writer_updates" "bytea"[] DEFAULT '{}'::bytea[] NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_state_valid" CHECK ("branch_push_settlement_outbox"."state" IN ('pending_live_settlement', 'parked'));