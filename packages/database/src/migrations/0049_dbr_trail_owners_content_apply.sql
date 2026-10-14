-- A content Apply pushes no journal rows: its owners are the chats behind the branch's active and
-- rollback_pending journal rows. The batch arm of capture_change_trail_signal() and the triggers are untouched.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION change_trail_owners(
  edit_ids uuid[] DEFAULT '{}', journal_ids bigint[] DEFAULT '{}',
  push_ids bigint[] DEFAULT '{}', direct_thread uuid DEFAULT NULL, direct_turn uuid DEFAULT NULL
) RETURNS TABLE(thread_id uuid, turn_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE publications AS (
    SELECT * FROM push_lineage WHERE id = ANY(push_ids)
  ), journals AS (
    SELECT * FROM branch_write_journal j WHERE j.id = ANY(journal_ids)
      OR EXISTS (SELECT 1 FROM publications p WHERE j.id = ANY(p.journal_ids))
      OR EXISTS (
        SELECT 1 FROM publications p
        WHERE p.apply_payload IS NOT NULL AND j.branch_id = p.branch_id
          AND j.status IN ('active', 'rollback_pending')
      )
  ), edits(id) AS (
    SELECT unnest(edit_ids)
    UNION
    SELECT (update_meta->'documentEdit'->>'editId')::uuid FROM journals
      WHERE update_meta->'documentEdit'->>'editId' IS NOT NULL
    UNION
    SELECT (target->>'editId')::uuid FROM edits e
      JOIN document_edit_parts part ON part.edit_id = e.id
      CROSS JOIN LATERAL jsonb_array_elements(part.targets) target
  ), owners AS (
    SELECT direct_thread AS thread_id, direct_turn AS turn_id
    UNION SELECT j.thread_id, j.turn_id FROM journals j
    UNION SELECT p.thread_id, p.turn_id FROM publications p
    UNION SELECT e.thread_id, e.turn_id FROM document_edits e WHERE e.id IN (SELECT id FROM edits)
  )
  SELECT thread_id, turn_id FROM owners WHERE thread_id IS NOT NULL
  UNION SELECT thread_id, NULL::uuid FROM owners WHERE thread_id IS NOT NULL
$$;
