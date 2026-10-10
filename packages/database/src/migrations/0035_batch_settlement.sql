CREATE TABLE "branch_push_settlement_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claim_epoch" bigint DEFAULT 1 NOT NULL,
	"claim_kind" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"blocked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_batches_state_valid" CHECK ("branch_push_settlement_batches"."state" IN ('pending', 'blocked', 'completed')),
	CONSTRAINT "branch_push_settlement_batches_terminal_shape" CHECK ((
        ("branch_push_settlement_batches"."state" = 'completed' AND "branch_push_settlement_batches"."completed_at" IS NOT NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'blocked' AND "branch_push_settlement_batches"."blocked_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'pending' AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."completed_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_shape" CHECK ("branch_push_settlement_batches"."state" <> 'pending' OR (
        ("branch_push_settlement_batches"."claim_token" IS NOT NULL AND "branch_push_settlement_batches"."claim_kind" IS NOT NULL AND "branch_push_settlement_batches"."claimed_at" IS NOT NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NOT NULL)
        OR ("branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_kind_valid" CHECK ("branch_push_settlement_batches"."claim_kind" IS NULL OR "branch_push_settlement_batches"."claim_kind" IN ('warm', 'recovery')),
	CONSTRAINT "branch_push_settlement_batches_counters_valid" CHECK ("branch_push_settlement_batches"."attempt_count" >= 0 AND "branch_push_settlement_batches"."claim_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_state_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_terminal_shape";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_shape";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_kind_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_counters_valid";--> statement-breakpoint
DROP INDEX "branch_push_settlement_outbox_recovery";--> statement-breakpoint
DROP INDEX "branch_push_settlement_outbox_document_unresolved";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
INSERT INTO "branch_push_settlement_batches" ("id", "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at")
SELECT md5('branch-push-settlement:' || "push_id")::uuid, "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at"
FROM "branch_push_settlement_outbox";--> statement-breakpoint
UPDATE "branch_push_settlement_outbox" SET "batch_id" = md5('branch-push-settlement:' || "push_id")::uuid; -- migration-lint: skip UPDATE_WITHOUT_WHERE (each existing push becomes a batch of one)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "batch_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (backfilled above)
--> statement-breakpoint
CREATE INDEX "branch_push_settlement_batches_recovery" ON "branch_push_settlement_batches" USING btree ("available_at","lease_expires_at","created_at") WHERE "branch_push_settlement_batches"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "branch_push_settlement_batches_unresolved" ON "branch_push_settlement_batches" USING btree ("id") WHERE "branch_push_settlement_batches"."state" <> 'completed';--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_document" ON "branch_push_settlement_outbox" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_push_settlement_outbox_batch_document" ON "branch_push_settlement_outbox" USING btree ("batch_id","document_id");--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "state"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns settlement state)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "settled_join_version"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_token"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_epoch"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_kind"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claimed_at"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "lease_expires_at"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "available_at"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "attempt_count"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "last_error_code"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "last_error"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "blocked_at"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "completed_at"; -- migration-lint: skip DROP_COLUMN (no deployed data; the batch row owns claims and the completion transaction owns the join fence)--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_counters_valid" CHECK ("branch_push_settlement_outbox"."join_version" >= 0 AND "branch_push_settlement_outbox"."classified_join_version" <= "branch_push_settlement_outbox"."join_version");