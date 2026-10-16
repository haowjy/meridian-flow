-- data-step: review-base-conversion@1
-- B3, the anchor. The runner converts every draft's review base immediately before this file; the
-- guards below are defense in depth and fire only if that step was bypassed. Dropping live_cut destroys
-- the only copy of a pre-review_base draft's baseline. Repair or recover a baseline; never discard a draft.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $$
DECLARE
  offenders text;
BEGIN
  -- Definitions, not names: B2 reuses the index names.
  SELECT string_agg(format('%I.%I', tablename, indexname), ', ' ORDER BY tablename, indexname) INTO offenders
  FROM pg_indexes
  WHERE schemaname = current_schema()
    AND tablename IN ('document_branches', 'branch_write_journal', 'push_lineage', 'document_edit_parts')
    AND indexdef ~ '\y(generation|branch_generation|live_cut|discarded_state_vector)\y';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'review-base-conversion guard: indexes still use a dropped column: %', offenders;
  END IF;

  -- The same predicate the data step converts (ELIGIBLE_BRANCH_PREDICATE).
  SELECT string_agg(format('branch %s (document %s)', b.id, b.document_id), ', ' ORDER BY b.id) INTO offenders
  FROM (
    SELECT b.id, b.document_id FROM document_branches b
    WHERE b.kind = 'work_draft' AND b.status = 'active' AND b.base_revision IS NULL
    ORDER BY b.id LIMIT 20
  ) AS b;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'review-base-conversion guard: draft branches have no review base (first 20): %. Repair or recover each baseline, then run db:migrate again; do not discard the drafts.', offenders;
  END IF;

  SELECT string_agg(format('batch %s (%s)', id, state), ', ' ORDER BY created_at, id) INTO offenders
  FROM (
    SELECT id, state, created_at FROM branch_push_settlement_batches
    WHERE state IN ('pending', 'blocked') ORDER BY created_at, id LIMIT 20
  ) AS unfinished;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'review-base-conversion guard: unfinished settlement batches (first 20): %', offenders;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "branch_write_journal" DROP COLUMN "generation";--> statement-breakpoint
ALTER TABLE "document_branches" DROP COLUMN "live_cut";--> statement-breakpoint
ALTER TABLE "document_branches" DROP COLUMN "discarded_state_vector";--> statement-breakpoint
ALTER TABLE "document_branches" DROP COLUMN "generation";--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "branch_generation";
