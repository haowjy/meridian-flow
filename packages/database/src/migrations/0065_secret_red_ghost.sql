DROP INDEX "push_lineage_branch";--> statement-breakpoint
ALTER TABLE "push_lineage" ADD COLUMN "branch_generation" integer;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "push_lineage"
		WHERE CASE
			WHEN jsonb_typeof("receipt_payload"->'branchGeneration') = 'number'
				AND "receipt_payload"->>'branchGeneration' ~ '^[1-9][0-9]*$'
			THEN ("receipt_payload"->>'branchGeneration')::numeric BETWEEN 1 AND 2147483647
			ELSE false
		END IS NOT TRUE
	) THEN
		-- Publication generation is lineage evidence. Abort on missing or malformed
		-- legacy evidence rather than assign a plausible but incorrect generation.
		RAISE EXCEPTION 'push_lineage contains rows without a recoverable branchGeneration';
	END IF;
END
$$;--> statement-breakpoint
UPDATE "push_lineage"
SET "branch_generation" = ("receipt_payload"->>'branchGeneration')::integer; -- migration-lint: skip UPDATE_WITHOUT_WHERE (every validated legacy publication row must be backfilled)--> statement-breakpoint
ALTER TABLE "push_lineage" ALTER COLUMN "branch_generation" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (legacy rows are validated and backfilled above)--> statement-breakpoint
CREATE INDEX "push_lineage_branch" ON "push_lineage" USING btree ("branch_id","branch_generation"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release schema; populated rows are backfilled above)--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "push_kind"; -- migration-lint: skip DROP_COLUMN (pre-release publication-summary removal)--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "receipt_payload"; -- migration-lint: skip DROP_COLUMN (pre-release duplicate publication-record removal)
