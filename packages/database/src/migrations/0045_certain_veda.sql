ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "change_count" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "swept_change_count" integer;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD COLUMN "document_count" integer;--> statement-breakpoint
UPDATE "change_trail_delivery_outbox" AS outbox SET
  "change_count" = shell."change_count",
  "swept_change_count" = shell."swept_change_count",
  "document_count" = shell."document_count"
FROM "change_trail_shells" AS shell
WHERE outbox."trail_id" = shell."id" AND outbox."event_kind" = 'updated';--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK (("change_trail_delivery_outbox"."event_kind" = 'settled' AND "change_trail_delivery_outbox"."change_count" IS NULL AND "change_trail_delivery_outbox"."swept_change_count" IS NULL AND "change_trail_delivery_outbox"."document_count" IS NULL) OR ("change_trail_delivery_outbox"."event_kind" = 'updated' AND "change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" >= 0 AND "change_trail_delivery_outbox"."swept_change_count" <= "change_trail_delivery_outbox"."change_count" AND "change_trail_delivery_outbox"."document_count" >= 0));--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_state_counts_valid" CHECK ("change_trail_shells"."state" IN ('building', 'settling', 'settled') AND "change_trail_shells"."version" > 0 AND "change_trail_shells"."change_count" >= 0 AND "change_trail_shells"."swept_change_count" >= 0 AND "change_trail_shells"."swept_change_count" <= "change_trail_shells"."change_count" AND "change_trail_shells"."document_count" >= 0 AND (("change_trail_shells"."state" = 'settled') = ("change_trail_shells"."settled_at" IS NOT NULL)));