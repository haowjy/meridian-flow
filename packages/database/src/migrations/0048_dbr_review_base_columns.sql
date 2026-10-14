-- The diff-based review's columns: the base revision a draft's review_base reflects, the retained rebase
-- cuts, and a content Apply's durable payload. All metadata-only on a populated table (nullable or
-- constant defaults). has_effect now defaults false: every write sets it explicitly.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "has_effect" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "base_revision" jsonb;--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "rebase_cuts" "bytea"[] DEFAULT '{}'::bytea[] NOT NULL;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD COLUMN "apply_payload" jsonb;