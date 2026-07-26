DROP TABLE "model_response_causal_cuts" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_entries" CASCADE;--> statement-breakpoint
DROP TABLE "model_response_observation_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" DROP CONSTRAINT "change_trail_delivery_outbox_counts_valid";--> statement-breakpoint
-- The old constraint required settled rows to store NULL counts. A same-version
-- shell is exact; after a reopen, the preceding updated event is the retained
-- settled snapshot. Zero is reserved for incomplete rows with neither source.
WITH recovered_settled_counts AS (
  SELECT
    settled."event_id",
    COALESCE(
      CASE WHEN settled."version" = shell."version" THEN shell."change_count" END,
      preceding_updated."change_count",
      0
    ) AS "change_count",
    COALESCE(
      CASE WHEN settled."version" = shell."version" THEN shell."swept_change_count" END,
      preceding_updated."swept_change_count",
      0
    ) AS "swept_change_count",
    COALESCE(
      CASE WHEN settled."version" = shell."version" THEN shell."document_count" END,
      preceding_updated."document_count",
      0
    ) AS "document_count"
  FROM "change_trail_delivery_outbox" AS settled
  INNER JOIN "change_trail_shells" AS shell ON shell."id" = settled."trail_id"
  LEFT JOIN LATERAL (
    SELECT
      updated."change_count",
      updated."swept_change_count",
      updated."document_count"
    FROM "change_trail_delivery_outbox" AS updated
    WHERE updated."trail_id" = settled."trail_id"
      AND updated."event_kind" = 'updated'
      AND updated."version" < settled."version"
    ORDER BY updated."version" DESC
    LIMIT 1
  ) AS preceding_updated ON true
  WHERE settled."event_kind" = 'settled'
)
UPDATE "change_trail_delivery_outbox" AS outbox
SET
  "change_count" = recovered."change_count",
  "swept_change_count" = recovered."swept_change_count",
  "document_count" = recovered."document_count"
FROM recovered_settled_counts AS recovered
WHERE outbox."event_id" = recovered."event_id";--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "change_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "swept_change_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ALTER COLUMN "document_count" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy NULLs backfilled above)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "words_removed" integer;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "lineage_evidence"; -- migration-lint: skip (pre-release observation-model removal; no readers, no data)--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK ("change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" <= "change_trail_delivery_outbox"."change_count" AND "change_trail_delivery_outbox"."document_count" >= 0);
