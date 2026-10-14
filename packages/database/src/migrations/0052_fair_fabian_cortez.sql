-- migration: no-transaction
-- B2: branch generations leave the receipts and every index over them. Every statement is re-runnable;
-- a failed file reruns from its first statement and ends in the same state.
--
-- 1. Rewrite document_edit_parts in committed batches: strip `generation` from placement and origin,
--    `retired` becomes `discarded`, only rows that change are touched. Each touched row fires
--    capture_change_trail_part (never disabled), so batches stay small and commit between rounds.
DO $$
DECLARE
  last_id bigint := 0;
  batch_end bigint;
BEGIN
  LOOP
    SELECT max(id) INTO batch_end FROM (
      SELECT id FROM document_edit_parts
      WHERE id > last_id
        AND (placement ? 'generation' OR origin ? 'generation' OR placement->>'kind' = 'retired')
      ORDER BY id
      LIMIT 1000
    ) AS batch;
    EXIT WHEN batch_end IS NULL;
    UPDATE document_edit_parts
    SET placement = CASE
          WHEN placement->>'kind' = 'retired' THEN '{"kind": "discarded"}'::jsonb
          ELSE placement - 'generation'
        END,
        origin = origin - 'generation'
    WHERE id > last_id AND id <= batch_end
      AND (placement ? 'generation' OR origin ? 'generation' OR placement->>'kind' = 'retired');
    last_id := batch_end;
    COMMIT;
  END LOOP;
END
$$;
--> statement-breakpoint
-- 2. Build each replacement index under a temporary name, then retire the old definition and rename.
--    The runner drops an INVALID remnant of a failed build before the file runs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edit_parts_pending_idx_new" ON "document_edit_parts" USING btree (("placement"->>'branchId')) WHERE "document_edit_parts"."placement"->>'kind' = 'pending';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_write_journal_branch_new" ON "branch_write_journal" USING btree ("branch_id","id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_write_journal_active_new" ON "branch_write_journal" USING btree ("branch_id","status") WHERE "branch_write_journal"."status" = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_branches_active_work_draft_by_draft_new" ON "document_branches" USING btree ("draft_id","id") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "push_lineage_branch_new" ON "push_lineage" USING btree ("branch_id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_edit_parts_pending_idx";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "branch_write_journal_branch";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "branch_write_journal_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_branches_active_work_draft_by_draft";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_lineage_branch";
--> statement-breakpoint
ALTER INDEX IF EXISTS "document_edit_parts_pending_idx_new" RENAME TO "document_edit_parts_pending_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "branch_write_journal_branch_new" RENAME TO "branch_write_journal_branch";
--> statement-breakpoint
ALTER INDEX IF EXISTS "branch_write_journal_active_new" RENAME TO "branch_write_journal_active";
--> statement-breakpoint
ALTER INDEX IF EXISTS "document_branches_active_work_draft_by_draft_new" RENAME TO "document_branches_active_work_draft_by_draft";
--> statement-breakpoint
ALTER INDEX IF EXISTS "push_lineage_branch_new" RENAME TO "push_lineage_branch";
--> statement-breakpoint
-- 3. The narrowed placement check goes in beside the old one (no window without a check), under a new
--    name, NOT VALID. Rows were rewritten above, so VALIDATE passes; it runs outside any exclusive lock.
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'document_edit_parts'::regclass AND conname = 'document_edit_parts_placement_kind_valid'
  ) THEN
    ALTER TABLE "document_edit_parts" ADD CONSTRAINT "document_edit_parts_placement_kind_valid" CHECK ("document_edit_parts"."placement"->>'kind' IN ('pending','live','discarded')) NOT VALID;
  END IF;
END
$$;
COMMIT;
--> statement-breakpoint
ALTER TABLE "document_edit_parts" VALIDATE CONSTRAINT "document_edit_parts_placement_kind_valid";
--> statement-breakpoint
-- 4. Retire the old check in a short transaction; the validated replacement already guards every write.
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE "document_edit_parts" DROP CONSTRAINT IF EXISTS "document_edit_parts_placement_valid";
COMMIT;
