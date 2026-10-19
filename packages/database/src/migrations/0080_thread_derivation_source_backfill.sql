-- migration: no-transaction
-- Old derivations did not retain the acted-on thread. The cutoff owner is the best
-- historical provenance available; new creates record the explicit source instead.
CREATE OR REPLACE PROCEDURE backfill_thread_derivation_source(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  cursor_id uuid;
  next_id uuid;
  page_ids uuid[];
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF cursor_id IS NULL THEN
      SELECT array_agg(id), max(id::text)::uuid INTO page_ids, next_id FROM (
        SELECT id FROM threads ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id), max(id::text)::uuid INTO page_ids, next_id FROM (
        SELECT id FROM threads WHERE id > cursor_id ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN next_id IS NULL;
    UPDATE threads t SET derivation_source_thread_id = origin.thread_id
    FROM turns origin WHERE t.id = ANY(page_ids) AND t.origin_type IN ('fork', 'handoff')
      AND t.derivation_source_thread_id IS NULL AND origin.id = t.origin_turn_id;
    cursor_id := next_id;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_thread_derivation_source(500);
--> statement-breakpoint
DROP PROCEDURE backfill_thread_derivation_source(integer);
