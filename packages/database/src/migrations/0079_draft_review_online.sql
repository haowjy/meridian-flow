-- migration: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edit_parts_pending_origin_idx" ON "document_edit_parts" ((origin->>'draftId')) WHERE origin->>'kind' = 'pending';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_drafts_active_work_draft_by_branch_next" ON "document_drafts" (branch_id, id) WHERE kind = 'work_draft' AND status = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "draft_write_journal_draft_next" ON "draft_write_journal" (draft_id, id);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "draft_write_journal_active_next" ON "draft_write_journal" (draft_id, status) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "push_lineage_draft_next" ON "push_lineage" (draft_id);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_edit_parts_pending_idx";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "branch_commands_settlement_batch";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_drafts_active_work_draft_by_branch";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "draft_write_journal_draft";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "draft_write_journal_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "push_lineage_draft";
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE retire_draft_review_values(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE part_cursor bigint; part_ids bigint[]; journal_cursor bigint; journal_ids bigint[];
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF part_cursor IS NULL THEN
      SELECT array_agg(id ORDER BY id) INTO part_ids FROM (
        SELECT id FROM document_edit_parts ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id ORDER BY id) INTO part_ids FROM (
        SELECT id FROM document_edit_parts WHERE id > part_cursor
          ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN part_ids IS NULL;
    UPDATE document_edit_parts SET origin = origin - 'generation'
      WHERE id = ANY(part_ids) AND origin ? 'generation';
    part_cursor := part_ids[array_length(part_ids, 1)];
    COMMIT;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF journal_cursor IS NULL THEN
      SELECT array_agg(id ORDER BY id) INTO journal_ids FROM (
        SELECT id FROM draft_write_journal ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id ORDER BY id) INTO journal_ids FROM (
        SELECT id FROM draft_write_journal WHERE id > journal_cursor
          ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN journal_ids IS NULL;
    UPDATE draft_write_journal SET status = 'active'
      WHERE id = ANY(journal_ids) AND status IN ('pushed', 'discarded');
    journal_cursor := journal_ids[array_length(journal_ids, 1)];
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL retire_draft_review_values(500);
--> statement-breakpoint
DROP PROCEDURE retire_draft_review_values(integer);
