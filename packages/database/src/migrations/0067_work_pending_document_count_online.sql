-- migration: no-transaction
-- Online half of 0066: every Work's stored pending count set to the collab membership rule's
-- count (`createDrizzleWorkDraftPendingStore`'s twin), its revision bumped where it moved so a
-- client holding the old snapshot refetches. Keyset batches on `id`, one commit each. A batch
-- locks its Works first and counts in a later statement (a fresh READ COMMITTED snapshot), the
-- order the server's reconcile takes, so neither overwrites the other's newer count. A Work
-- counted to zero is written too, which keeps a re-run exact. Re-runnable.
CREATE OR REPLACE PROCEDURE work_pending_document_count_backfill(batch_size int) LANGUAGE plpgsql AS $$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  ids uuid[];
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    SELECT array_agg(id ORDER BY id) INTO ids FROM (
      SELECT id FROM works WHERE id > last_id ORDER BY id LIMIT batch_size FOR NO KEY UPDATE
    ) batch;
    EXIT WHEN ids IS NULL;
    WITH pending AS (
      SELECT d.origin_work_id AS work_id, b.document_id
        FROM document_branches b
        JOIN drafts d ON d.id = b.draft_id
       WHERE d.origin_work_id = ANY (ids)
         AND d.status = 'active'
         AND b.kind = 'work_draft'
         AND b.status = 'active'
         AND (b.has_effect OR b.blocking)
         AND EXISTS (
           SELECT 1 FROM branch_write_journal j
            WHERE j.branch_id = b.id
              AND j.generation = b.generation
              AND j.status IN ('active', 'rollback_pending'))
      UNION
      SELECT d.origin_work_id, c.node_id
        FROM draft_tree_changes c
        JOIN drafts d ON d.id = c.draft_id
       WHERE d.origin_work_id = ANY (ids)
         AND d.status = 'active'
         AND c.node_kind = 'document'
    ),
    counted AS (
      SELECT w.id, coalesce(p.n, 0) AS n
        FROM unnest(ids) AS w(id)
        LEFT JOIN (SELECT work_id, count(*)::int AS n FROM pending GROUP BY work_id) p
          ON p.work_id = w.id
    )
    UPDATE works
       SET pending_document_count = counted.n,
           entity_revision = works.entity_revision + 1
      FROM counted
     WHERE works.id = counted.id
       AND works.pending_document_count <> counted.n;
    last_id := ids[array_length(ids, 1)];
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL work_pending_document_count_backfill(500);
--> statement-breakpoint
DROP PROCEDURE work_pending_document_count_backfill(int);
