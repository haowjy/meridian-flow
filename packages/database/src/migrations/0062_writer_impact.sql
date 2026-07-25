ALTER TABLE "change_trail_delivery_outbox" RENAME COLUMN "swept_change_count" TO "writer_impact_count";--> statement-breakpoint
ALTER TABLE "change_trail_shells" RENAME COLUMN "swept_change_count" TO "writer_impact_count";--> statement-breakpoint
UPDATE "change_trail_document_details"
SET "changes" = (
	SELECT COALESCE(
		jsonb_agg(
			("change" - 'swept' - 'writerProtection') || jsonb_build_object(
				'writerImpact',
				CASE
					WHEN "change"->'writerProtection'->>'kind' = 'resurrection'
						THEN "change"->'writerProtection'
					WHEN "change"->'swept' IS NOT NULL AND "change"->'swept' <> 'null'::jsonb
						THEN (
							jsonb_build_object(
								'kind', 'sweep',
								'affectedBlockHash', "change"->'swept'->'affectedBlockHash',
								'body', COALESCE(
									"change"->'writerProtection'->'body',
									"change"->'swept'->'removed'
								),
								'beforeContentRef', "change"->'swept'->'beforeContentRef'
							)
							|| CASE
								WHEN "change"->'swept'->'affectedBlockIdentity' IS NOT NULL
									AND "change"->'swept'->'affectedBlockIdentity' <> 'null'::jsonb
									THEN jsonb_build_object(
										'affectedBlockIdentity',
										"change"->'swept'->'affectedBlockIdentity'
									)
								ELSE '{}'::jsonb
							END
							|| CASE
								WHEN "change"->'writerProtection'->'ranges' IS NOT NULL
									AND "change"->'writerProtection'->'ranges' <> 'null'::jsonb
									THEN jsonb_build_object(
										'ranges',
										"change"->'writerProtection'->'ranges'
									)
								ELSE '{}'::jsonb
							END
						)
					ELSE 'null'::jsonb
				END
			)
			ORDER BY "ordinality"
		),
		'[]'::jsonb
	)
	FROM jsonb_array_elements("change_trail_document_details"."changes")
		WITH ORDINALITY AS "entry"("change", "ordinality")
);--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" DROP CONSTRAINT "change_trail_delivery_outbox_counts_valid";--> statement-breakpoint
ALTER TABLE "change_trail_shells" DROP CONSTRAINT "change_trail_shells_state_counts_valid";--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK (("change_trail_delivery_outbox"."event_kind" = 'settled' AND "change_trail_delivery_outbox"."change_count" IS NULL AND "change_trail_delivery_outbox"."writer_impact_count" IS NULL AND "change_trail_delivery_outbox"."document_count" IS NULL) OR ("change_trail_delivery_outbox"."event_kind" = 'updated' AND "change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."writer_impact_count" >= 0 AND "change_trail_delivery_outbox"."writer_impact_count" <= "change_trail_delivery_outbox"."change_count" AND "change_trail_delivery_outbox"."document_count" >= 0));--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_state_counts_valid" CHECK ("change_trail_shells"."state" IN ('building', 'settling', 'settled') AND "change_trail_shells"."version" > 0 AND "change_trail_shells"."change_count" >= 0 AND "change_trail_shells"."writer_impact_count" >= 0 AND "change_trail_shells"."writer_impact_count" <= "change_trail_shells"."change_count" AND "change_trail_shells"."document_count" >= 0 AND (("change_trail_shells"."state" = 'settled') = ("change_trail_shells"."settled_at" IS NOT NULL)));
