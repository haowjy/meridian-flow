-- migration: no-transaction
-- Folder entries published before chat identity was part of the entry cannot
-- name their chat, and a trashed chat must not offer one. Both facts are stable
-- on `folders` and `threads`; copy them once in bounded primary-key pages. Each
-- page moves the scope cursor too, so an open client resets to a snapshot that
-- carries the new facts instead of keeping the old grouping.
CREATE OR REPLACE PROCEDURE backfill_catalog_folder_thread(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  cursor_scope text;
  cursor_entry text;
  next_scope text;
  next_entry text;
  page_scopes text[];
  page_entries text[];
  page_folders uuid[];
BEGIN
  LOOP
    -- Catalog writers take the publisher fence before any head lock; take it
    -- first here as well, or a writer holding a head can wait on an entry this
    -- page locked while the page waits on that head.
    SET LOCAL lock_timeout = '5s';
    PERFORM pg_advisory_xact_lock(1296387666, 1096174676);
    SET LOCAL lock_timeout = '2s';
    WITH page AS (
      SELECT e.scope_key, e.entry_id, f.id AS folder_id
      FROM context_catalog_entries e
      JOIN folders f ON f.id = e.entry_id::uuid AND f.thread_id IS NOT NULL
      WHERE e.entry->>'kind' = 'folder'
        AND e.entry_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (NOT (e.entry ? 'threadId') OR NOT (e.entry ? 'chatAvailable'))
        AND (cursor_scope IS NULL OR (e.scope_key, e.entry_id) > (cursor_scope, cursor_entry))
      ORDER BY e.scope_key, e.entry_id
      LIMIT batch_size
      FOR UPDATE OF e
    )
    SELECT array_agg(scope_key ORDER BY scope_key, entry_id),
           array_agg(entry_id ORDER BY scope_key, entry_id),
           array_agg(folder_id ORDER BY scope_key, entry_id),
           (array_agg(scope_key ORDER BY scope_key DESC, entry_id DESC))[1],
           (array_agg(entry_id ORDER BY scope_key DESC, entry_id DESC))[1]
    INTO page_scopes, page_entries, page_folders, next_scope, next_entry
    FROM page;
    EXIT WHEN next_scope IS NULL;
    UPDATE context_catalog_entries e
    SET entry = jsonb_set(
      jsonb_set(e.entry, '{threadId}', to_jsonb(f.thread_id)),
      '{chatAvailable}', to_jsonb(t.id IS NOT NULL AND t.deleted_at IS NULL)
    )
    FROM unnest(page_scopes, page_entries, page_folders) AS page(scope_key, entry_id, folder_id)
    JOIN folders f ON f.id = page.folder_id
    LEFT JOIN threads t ON t.id = f.thread_id
    WHERE e.scope_key = page.scope_key AND e.entry_id = page.entry_id;
    UPDATE context_catalog_scope_heads h
    SET head_revision = h.head_revision + 1, updated_at = now()
    WHERE h.scope_key = ANY(page_scopes);
    cursor_scope := next_scope;
    cursor_entry := next_entry;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_catalog_folder_thread(500);
--> statement-breakpoint
DROP PROCEDURE backfill_catalog_folder_thread(integer);
