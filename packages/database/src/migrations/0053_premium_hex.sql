-- There is no production data. Reset legacy 0048/0049 rows rather than retain
-- two settlement authorities while the outbox contract changes shape.
TRUNCATE TABLE "branch_push_settlement_outbox";
--> statement-breakpoint
CREATE TABLE "branch_push_outbox_updates" (
	"push_id" bigint NOT NULL,
	"ordinal" bigint NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	CONSTRAINT "branch_push_outbox_updates_push_id_source_kind_source_id_pk" PRIMARY KEY("push_id","source_kind","source_id"),
	CONSTRAINT "branch_push_outbox_updates_ordinal_valid" CHECK ("branch_push_outbox_updates"."ordinal" >= 0),
	CONSTRAINT "branch_push_outbox_updates_source_kind_valid" CHECK ("branch_push_outbox_updates"."source_kind" IN ('journal', 'staged_push', 'initial_reconcile'))
);
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" RENAME COLUMN "baseline_state" TO "lock_cut_update";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" RENAME COLUMN "trail" TO "trail_seed";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" RENAME COLUMN "next_attempt_at" TO "available_at";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "available_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "available_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" RENAME COLUMN "settled_at" TO "completed_at";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_state_valid";--> statement-breakpoint
DROP INDEX "branch_push_settlement_outbox_pending";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "state" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "join_version" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "lineage_evidence" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "settled_join_version" bigint;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "claim_epoch" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "claim_kind" text;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branch_push_outbox_updates" ADD CONSTRAINT "branch_push_outbox_updates_push_id_branch_push_settlement_outbox_push_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."branch_push_settlement_outbox"("push_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_push_outbox_updates_ordinal" ON "branch_push_outbox_updates" USING btree ("push_id","ordinal");--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_recovery" ON "branch_push_settlement_outbox" USING btree ("available_at","lease_expires_at","created_at") WHERE "branch_push_settlement_outbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_document_unresolved" ON "branch_push_settlement_outbox" USING btree ("document_id") WHERE "branch_push_settlement_outbox"."state" <> 'completed';--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "writer_updates";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "deleted_parent_identities";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_terminal_shape" CHECK ((
        ("branch_push_settlement_outbox"."state" = 'completed' AND "branch_push_settlement_outbox"."completed_at" IS NOT NULL AND "branch_push_settlement_outbox"."blocked_at" IS NULL AND "branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_outbox"."state" = 'blocked' AND "branch_push_settlement_outbox"."blocked_at" IS NOT NULL AND "branch_push_settlement_outbox"."last_error_code" IS NOT NULL AND "branch_push_settlement_outbox"."completed_at" IS NULL AND "branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_outbox"."state" = 'pending' AND "branch_push_settlement_outbox"."blocked_at" IS NULL AND "branch_push_settlement_outbox"."completed_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_claim_shape" CHECK ("branch_push_settlement_outbox"."state" <> 'pending' OR (
        ("branch_push_settlement_outbox"."claim_token" IS NOT NULL AND "branch_push_settlement_outbox"."claim_kind" IS NOT NULL AND "branch_push_settlement_outbox"."claimed_at" IS NOT NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NOT NULL)
        OR ("branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_claim_kind_valid" CHECK ("branch_push_settlement_outbox"."claim_kind" IS NULL OR "branch_push_settlement_outbox"."claim_kind" IN ('warm', 'recovery'));--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_counters_valid" CHECK ("branch_push_settlement_outbox"."attempt_count" >= 0 AND "branch_push_settlement_outbox"."join_version" >= 0 AND "branch_push_settlement_outbox"."claim_epoch" >= 0 AND ("branch_push_settlement_outbox"."settled_join_version" IS NULL OR "branch_push_settlement_outbox"."settled_join_version" <= "branch_push_settlement_outbox"."join_version"));--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_state_valid" CHECK ("branch_push_settlement_outbox"."state" IN ('pending', 'blocked', 'completed'));
