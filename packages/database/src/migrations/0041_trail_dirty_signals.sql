-- Producers append signals without updating or locking projection owners.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP TRIGGER enlist_turn_trail_work ON branch_write_journal;
--> statement-breakpoint
DROP TRIGGER complete_turn_trail_work ON branch_write_journal;
--> statement-breakpoint
DROP FUNCTION enlist_turn_trail_work();
--> statement-breakpoint
DROP FUNCTION complete_turn_trail_work();
--> statement-breakpoint
CREATE FUNCTION change_trail_owners(
  edit_ids uuid[] DEFAULT '{}', journal_ids bigint[] DEFAULT '{}',
  push_ids bigint[] DEFAULT '{}', direct_thread uuid DEFAULT NULL, direct_turn uuid DEFAULT NULL
) RETURNS TABLE(thread_id uuid, turn_id uuid) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE publications AS (
    SELECT * FROM push_lineage WHERE id = ANY(push_ids)
  ), journals AS (
    SELECT * FROM branch_write_journal j WHERE j.id = ANY(journal_ids)
      OR EXISTS (SELECT 1 FROM publications p WHERE j.id = ANY(p.journal_ids))
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
--> statement-breakpoint
CREATE FUNCTION capture_change_trail_signal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_edits' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'document_edit_parts' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.edit_id]);
  ELSIF TG_TABLE_NAME = 'branch_write_journal' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'push_lineage' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'branch_push_settlement_outbox' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.push_id]);
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
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_receipt AFTER INSERT ON document_edits
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_part AFTER INSERT OR UPDATE OF placement ON document_edit_parts
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_journal AFTER INSERT OR UPDATE OF status ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_publication AFTER INSERT ON push_lineage
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_settlement AFTER INSERT OR UPDATE OF state ON branch_push_settlement_outbox
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_turn AFTER INSERT OR UPDATE OF status ON turns
FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
-- Existing receipts and journals include ownerless inverses targeting model edits.
INSERT INTO change_trail_dirty_log(thread_id, turn_id)
SELECT * FROM change_trail_owners(
  ARRAY(SELECT id FROM document_edits), ARRAY(SELECT id FROM branch_write_journal),
  ARRAY(SELECT id FROM push_lineage)
)
UNION SELECT thread_id, id FROM turns WHERE role = 'assistant'
UNION SELECT thread_id, turn_id FROM change_trail_shells
UNION SELECT thread_id, NULL::uuid FROM turns
UNION SELECT thread_id, NULL::uuid FROM change_trail_shells;
