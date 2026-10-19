-- migration: no-transaction
-- Page by native primary keys, committing each page. Re-running changes no settled row.
CREATE OR REPLACE PROCEDURE backfill_document_removal(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  document_cursor uuid; document_next uuid; document_ids uuid[];
  draft_cursor text; draft_next text; draft_ids text[];
  part_cursor bigint; part_next bigint; part_ids bigint[];
  item record;
BEGIN
  -- Separate first/range queries preserve indexed seeks even with PL/pgSQL generic plans.
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF document_cursor IS NULL THEN
      SELECT array_agg(id), max(id::text)::uuid INTO document_ids, document_next FROM (
        SELECT id FROM documents
        ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id), max(id::text)::uuid INTO document_ids, document_next FROM (
        SELECT id FROM documents WHERE id > document_cursor
        ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN document_next IS NULL;
    UPDATE documents SET deletion_reason = CASE
      WHEN deleted_by_work_id IS NOT NULL THEN 'deleted'
      WHEN hidden THEN 'discarded' ELSE 'deleted' END
    WHERE id = ANY(document_ids) AND deleted_at IS NOT NULL AND deletion_reason IS NULL;
    -- No FK points at these rows: receipts/settlements retain their own identity snapshots.
    DELETE FROM branch_tree_changes c USING documents d
      WHERE c.node_kind = 'document' AND c.node_id = d.id
        AND d.id = ANY(document_ids) AND d.deleted_at IS NOT NULL;
    document_cursor := document_next;
    COMMIT;
  END LOOP;
  -- Work parents before peers matches the runtime pull lock order.
  FOR item IN SELECT unnest(ARRAY['work_draft', 'thread_peer']) AS kind LOOP
    draft_cursor := NULL;
    LOOP
      SET LOCAL lock_timeout = '2s';
      IF draft_cursor IS NULL THEN
        SELECT array_agg(id), max(id) INTO draft_ids, draft_next FROM (
          SELECT id FROM document_drafts WHERE kind = item.kind
          ORDER BY id LIMIT batch_size FOR UPDATE
        ) page;
      ELSE
        SELECT array_agg(id), max(id) INTO draft_ids, draft_next FROM (
          SELECT id FROM document_drafts WHERE kind = item.kind AND id > draft_cursor
          ORDER BY id LIMIT batch_size FOR UPDATE
        ) page;
      END IF;
      EXIT WHEN draft_next IS NULL;
      UPDATE document_drafts b SET status = 'closed', closed_cause = 'document_removed',
        revision = revision + 1, updated_at = now()
      FROM documents d WHERE b.id = ANY(draft_ids) AND b.document_id = d.id
        AND b.status = 'active' AND d.deleted_at IS NOT NULL;
      UPDATE document_drafts SET closed_cause = 'discarded'
        WHERE id = ANY(draft_ids) AND status = 'closed' AND closed_cause IS NULL;
      draft_cursor := draft_next;
      COMMIT;
    END LOOP;
  END LOOP;
  -- Parts can outnumber drafts by orders of magnitude; bound their own updates too.
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF part_cursor IS NULL THEN
      SELECT array_agg(id), max(id) INTO part_ids, part_next FROM (
        SELECT id FROM document_edit_parts
        ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id), max(id) INTO part_ids, part_next FROM (
        SELECT id FROM document_edit_parts WHERE id > part_cursor
        ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN part_next IS NULL;
    UPDATE document_edit_parts p SET placement = '{"kind":"discarded"}'::jsonb
    FROM document_drafts b, documents d
    WHERE p.id = ANY(part_ids) AND p.placement->>'kind' = 'pending'
      AND p.placement->>'draftId' = b.id
      AND (p.placement->>'generation')::integer = b.generation
      AND b.document_id = d.id AND d.deleted_at IS NOT NULL
      AND b.status = 'closed' AND b.closed_cause = 'document_removed';
    part_cursor := part_next;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_document_removal(500);
--> statement-breakpoint
DROP PROCEDURE IF EXISTS backfill_document_removal(integer);
