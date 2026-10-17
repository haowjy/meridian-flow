-- migration: no-transaction
-- Online half of 0062_lock_free_branch_store. Every existing branch's checkpoint already holds
-- every journal row it has, so `checkpoint_seq` becomes the branch's highest journal id (its tail
-- is empty); `revision = checkpoint_revision = 0` is consistent for every existing row. Keyset
-- batches on `id` commit one at a time, so no batch holds its row locks past its own
-- transaction; a rowless branch still advances the cursor.
-- A row the old server appends during the backfill replays onto a checkpoint that already
-- contains it (a Yjs no-op). Re-runnable.
CREATE OR REPLACE PROCEDURE lock_free_branch_store_backfill(batch_size int) LANGUAGE plpgsql AS $$
DECLARE
  last_id text := '';
  next_id text;
  n int;
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    WITH batch AS (
      SELECT id FROM document_branches WHERE id > last_id ORDER BY id LIMIT batch_size
    ),
    done AS (
      UPDATE document_branches b
         SET checkpoint_seq = coalesce(
               (SELECT max(j.id) FROM branch_write_journal j WHERE j.branch_id = b.id), 0)
       WHERE b.id IN (SELECT id FROM batch)
       RETURNING b.id
    )
    SELECT max(id), count(*) INTO next_id, n FROM done;
    EXIT WHEN n = 0;
    last_id := next_id;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL lock_free_branch_store_backfill(500);
--> statement-breakpoint
DROP PROCEDURE lock_free_branch_store_backfill(int);
