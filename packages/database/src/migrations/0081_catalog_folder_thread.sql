-- migration: no-transaction
-- Folder entries published before the thread identity was part of the entry
-- cannot name their chat. The owning thread is stable on `folders`; copy it
-- once, in batches, so a stale entry does not need a catalog refresh.
CREATE OR REPLACE PROCEDURE backfill_catalog_folder_thread(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  cursor_id uuid;
  next_id uuid;
  page_ids uuid[];
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF cursor_id IS NULL THEN
      SELECT array_agg(id), max(id::text)::uuid INTO page_ids, next_id FROM (
        SELECT id FROM folders WHERE thread_id IS NOT NULL ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id), max(id::text)::uuid INTO page_ids, next_id FROM (
        SELECT id FROM folders WHERE thread_id IS NOT NULL AND id > cursor_id ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN next_id IS NULL;
    UPDATE context_catalog_entries e
    SET entry = jsonb_set(e.entry, '{threadId}', to_jsonb(f.thread_id))
    FROM folders f
    WHERE f.id = ANY(page_ids)
      AND e.entry_id = f.id::text
      AND e.entry->>'kind' = 'folder'
      AND NOT (e.entry ? 'threadId');
    cursor_id := next_id;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_catalog_folder_thread(500);
--> statement-breakpoint
-- A client holding the old cursor must ask again: no commit exists for the new
-- revision, so it resets and takes a fresh snapshot that carries the identity.
UPDATE context_catalog_scope_heads h
SET head_revision = h.head_revision + 1, updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM context_catalog_entries e
  WHERE e.scope_key = h.scope_key
    AND e.entry->>'kind' = 'folder'
    AND e.entry ? 'threadId'
);
--> statement-breakpoint
DROP PROCEDURE backfill_catalog_folder_thread(integer);
