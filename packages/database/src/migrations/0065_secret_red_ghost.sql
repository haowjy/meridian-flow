DROP INDEX "push_lineage_branch";--> statement-breakpoint
ALTER TABLE "push_lineage" ADD COLUMN "branch_generation" integer NOT NULL;--> statement-breakpoint
CREATE INDEX "push_lineage_branch" ON "push_lineage" USING btree ("branch_id","branch_generation"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release schema; no production rows)--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "push_kind"; -- migration-lint: skip DROP_COLUMN (pre-release publication-summary removal; no production rows)--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "receipt_payload"; -- migration-lint: skip DROP_COLUMN (pre-release duplicate publication-record removal; no production rows)
