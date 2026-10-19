-- Committed Apply supplies all member owners explicitly; no draft replay or settlement readers.
CREATE OR REPLACE FUNCTION change_trail_owners(
  edit_ids uuid[] DEFAULT '{}', journal_ids bigint[] DEFAULT '{}',
  push_ids bigint[] DEFAULT '{}', direct_thread uuid DEFAULT NULL, direct_turn uuid DEFAULT NULL
) RETURNS TABLE(thread_id uuid, turn_id uuid) LANGUAGE sql STABLE SET jit = off AS $$
  WITH RECURSIVE publications AS (
    SELECT p.thread_id, p.turn_id FROM push_lineage p
    WHERE p.id = ANY(change_trail_owners.push_ids)
  ), journals AS (
    SELECT j.thread_id, j.turn_id, j.update_meta FROM draft_write_journal j
    WHERE j.id = ANY(
      change_trail_owners.journal_ids
    )
  ), edits(id) AS (
    SELECT unnest(change_trail_owners.edit_ids)
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION capture_change_trail_signal() RETURNS trigger LANGUAGE plpgsql SET jit = off AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_edits' THEN
    -- Owners come from the receipt's thread and its parts' targets; parts insert after it.
    IF NEW.thread_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM document_edit_parts WHERE edit_id = NEW.id) THEN
      RETURN NEW;
    END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'document_edit_parts' THEN
    -- Receipt evidence, not mutable placement, determines owners.
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.edit_id]);
  ELSIF TG_TABLE_NAME = 'draft_write_journal' THEN
    -- Owners come only from the row's thread and its `documentEdit` link.
    IF NEW.thread_id IS NULL AND NEW.update_meta->'documentEdit'->>'editId' IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'push_lineage' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME IN ('branch_push_settlement_outbox', 'branch_push_settlement_batches') THEN
    RETURN NEW;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      VALUES (NEW.thread_id, NULL);
    IF NEW.role = 'assistant' OR EXISTS (
      SELECT 1 FROM change_trail_shells WHERE turn_id = NEW.id
    ) THEN
      INSERT INTO change_trail_dirty_log(thread_id, turn_id) VALUES (NEW.thread_id, NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
