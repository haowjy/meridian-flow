DROP TABLE "model_response_causal_cuts" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_entries" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" DROP CONSTRAINT "change_trail_delivery_outbox_counts_valid";--> statement-breakpoint
-- The old constraint required settled rows to store NULL counts. A matching shell
-- version is the exact settled snapshot; once the shell has reopened, the old
-- version's counts are unrecoverable, so preserve no invented history as zeroes.
UPDATE "change_trail_delivery_outbox" AS outbox
SET
  "change_count" = CASE WHEN outbox."version" = shell."version" THEN shell."change_count" ELSE 0 END,
  "swept_change_count" = CASE WHEN outbox."version" = shell."version" THEN shell."swept_change_count" ELSE 0 END,
  "document_count" = CASE WHEN outbox."version" = shell."version" THEN shell."document_count" ELSE 0 END
FROM "change_trail_shells" AS shell
WHERE outbox."trail_id" = shell."id"
  AND outbox."event_kind" = 'settled';--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "change_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "swept_change_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "document_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "words_removed" integer;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "lineage_evidence"; -- migration-lint: skip (pre-release observation-model removal; no readers, no data)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK ("change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" <= "change_trail_delivery_outbox"."change_count" AND "change_trail_delivery_outbox"."document_count" >= 0);
