ALTER TABLE "change_trail_delivery_outbox" DROP CONSTRAINT "change_trail_delivery_outbox_counts_valid";--> statement-breakpoint
ALTER TABLE "change_trail_shells" DROP CONSTRAINT "change_trail_shells_state_counts_valid";--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" DROP COLUMN "swept_change_count";--> statement-breakpoint
ALTER TABLE "change_trail_shells" DROP COLUMN "swept_change_count";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "before_content_ref";--> statement-breakpoint
UPDATE "change_trail_document_details"
SET "changes" = (
	SELECT COALESCE(
		jsonb_agg(
			"change" - 'forwardActions' - 'restore' - 'swept' - 'writerProtection' - 'writerImpact'
			ORDER BY "ordinality"
		),
		'[]'::jsonb
	)
	FROM jsonb_array_elements("change_trail_document_details"."changes")
		WITH ORDINALITY AS "entry"("change", "ordinality")
);--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK ("change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."document_count" >= 0);--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_state_counts_valid" CHECK ("change_trail_shells"."state" IN ('building', 'settling', 'settled') AND "change_trail_shells"."version" > 0 AND "change_trail_shells"."change_count" >= 0 AND "change_trail_shells"."document_count" >= 0 AND (("change_trail_shells"."state" = 'settled') = ("change_trail_shells"."settled_at" IS NOT NULL)));
