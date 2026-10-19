-- migration: no-transaction
-- Page by native primary keys, committing each page. Re-running changes no settled row.
CREATE OR REPLACE PROCEDURE backfill_document_removal(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  document_cursor uuid; document_next uuid; document_ids uuid[];
  draft_cursor text; draft_next text; draft_ids text[];
  part_cursor bigint; part_next bigint; part_ids bigint[];
  use_branch uuid; use_kind text; use_node uuid; use_next record; use_keys jsonb;
  work_cursor uuid; work_ids uuid[];
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
    document_cursor := document_next;
    COMMIT;
  END LOOP;
  -- Bound use deletion by its own composite key, not the number of owning documents.
  -- Hidden cascade membership is retained for Restore, including legacy creations.
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF use_branch IS NULL THEN
      SELECT jsonb_agg(to_jsonb(page) ORDER BY branch_id, node_kind, node_id) INTO use_keys FROM (
        SELECT c.branch_id, c.node_kind, c.node_id
        FROM branch_tree_changes c
        ORDER BY c.branch_id, c.node_kind, c.node_id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT jsonb_agg(to_jsonb(page) ORDER BY branch_id, node_kind, node_id) INTO use_keys FROM (
        SELECT c.branch_id, c.node_kind, c.node_id
        FROM branch_tree_changes c
        WHERE (c.branch_id, c.node_kind, c.node_id) >
              (use_branch, use_kind, use_node)
        ORDER BY c.branch_id, c.node_kind, c.node_id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN use_keys IS NULL;
    SELECT * INTO use_next FROM jsonb_to_record(use_keys->(jsonb_array_length(use_keys)-1))
      AS k(branch_id uuid, node_kind text, node_id uuid);
    DELETE FROM branch_tree_changes c USING documents d,
      jsonb_to_recordset(use_keys) AS k(branch_id uuid, node_kind text, node_id uuid)
    WHERE (c.branch_id, c.node_kind, c.node_id) = (k.branch_id, k.node_kind, k.node_id)
      AND c.node_kind = 'document' AND c.node_id = d.id
      AND d.deleted_at IS NOT NULL AND (d.deleted_by_work_id IS NULL OR NOT d.hidden);
    use_branch := use_next.branch_id; use_kind := use_next.node_kind; use_node := use_next.node_id;
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
        AND b.status = 'active' AND (d.deleted_at IS NOT NULL OR (
          b.kind = 'thread_peer' AND EXISTS (
            SELECT 1 FROM document_drafts parent WHERE parent.id = b.upstream_draft_id
              AND parent.status = 'closed' AND parent.closed_cause = 'document_removed')));
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
    FROM document_drafts b
    WHERE p.id = ANY(part_ids) AND p.placement->>'kind' = 'pending'
      AND p.placement->>'draftId' = b.id
      AND (p.placement->>'generation')::integer = b.generation
      AND b.status = 'closed' AND b.closed_cause = 'document_removed';
    part_cursor := part_next;
    COMMIT;
  END LOOP;
  -- Work-first locking, then a fresh snapshot, matches the runtime projection boundary.
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF work_cursor IS NULL THEN
      SELECT array_agg(id ORDER BY id) INTO work_ids FROM (
        SELECT id FROM works
        ORDER BY id LIMIT batch_size FOR NO KEY UPDATE
      ) page;
    ELSE
      SELECT array_agg(id ORDER BY id) INTO work_ids FROM (
        SELECT id FROM works WHERE id > work_cursor
        ORDER BY id LIMIT batch_size FOR NO KEY UPDATE
      ) page;
    END IF;
    EXIT WHEN work_ids IS NULL;
    WITH pending AS (
      SELECT r.origin_work_id AS work_id, b.document_id
      FROM document_drafts b JOIN branches r ON r.id = b.branch_id
      WHERE r.origin_work_id = ANY(work_ids) AND r.status = 'active'
        AND b.kind = 'work_draft' AND b.status = 'active' AND (b.has_effect OR b.blocking)
        AND EXISTS (SELECT 1 FROM draft_write_journal j
          WHERE j.draft_id = b.id AND j.generation = b.generation
            AND j.status IN ('active', 'rollback_pending'))
      UNION
      SELECT r.origin_work_id, c.node_id FROM branch_tree_changes c
      JOIN branches r ON r.id = c.branch_id JOIN documents d ON d.id = c.node_id
      WHERE r.origin_work_id = ANY(work_ids) AND r.status = 'active'
        AND c.node_kind = 'document' AND d.deleted_at IS NULL
    ), counted AS (
      SELECT w.id, coalesce(p.n, 0) AS n FROM unnest(work_ids) AS w(id)
      LEFT JOIN (SELECT work_id, count(*)::int AS n FROM pending GROUP BY work_id) p
        ON p.work_id = w.id
    )
    UPDATE works SET pending_document_count = counted.n,
      entity_revision = works.entity_revision + 1
    FROM counted WHERE works.id = counted.id AND works.pending_document_count <> counted.n;
    work_cursor := work_ids[array_length(work_ids, 1)];
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_document_removal(500);
--> statement-breakpoint
DROP PROCEDURE IF EXISTS backfill_document_removal(integer);
