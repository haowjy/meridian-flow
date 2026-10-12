-- Owner invalidation is part of the command transaction, never a worker hint.
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
CREATE FUNCTION dirty_change_trail_owner(p_thread_id uuid, p_turn_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_thread_id IS NULL THEN RETURN; END IF;
  IF p_turn_id IS NOT NULL THEN
    UPDATE turns SET trail_dirty_revision = trail_dirty_revision + 1
    WHERE id = p_turn_id AND thread_id = p_thread_id;
  END IF;
  UPDATE threads SET trail_dirty_revision = trail_dirty_revision + 1
  WHERE id = p_thread_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION dirty_change_trail_from_owned_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dirty_change_trail_owner(NEW.thread_id, NEW.turn_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_journal AFTER INSERT OR UPDATE OF status ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_owned_row();
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_receipt AFTER INSERT ON document_edits
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_owned_row();
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_publication AFTER INSERT ON push_lineage
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_owned_row();
--> statement-breakpoint
CREATE FUNCTION dirty_change_trail_from_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner document_edits%ROWTYPE;
BEGIN
  SELECT * INTO owner FROM document_edits WHERE id = NEW.edit_id;
  PERFORM dirty_change_trail_owner(owner.thread_id, owner.turn_id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_placement AFTER INSERT OR UPDATE OF placement ON document_edit_parts
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_part();
--> statement-breakpoint
CREATE FUNCTION dirty_change_trail_from_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Update NEW rather than recursively updating the turn whose status is changing.
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.role = 'assistant' OR NEW.trail_dirty_revision > 0 THEN
      NEW.trail_dirty_revision := NEW.trail_dirty_revision + 1;
    END IF;
    UPDATE threads SET trail_dirty_revision = trail_dirty_revision + 1
    WHERE id = NEW.thread_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_turn BEFORE INSERT OR UPDATE OF status ON turns
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_turn();
--> statement-breakpoint
CREATE FUNCTION dirty_change_trail_from_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner push_lineage%ROWTYPE;
BEGIN
  SELECT * INTO owner FROM push_lineage WHERE id = NEW.push_id;
  PERFORM dirty_change_trail_owner(owner.thread_id, owner.turn_id);
  -- A publication may include several originating chats, not just its admitter.
  PERFORM dirty_change_trail_owner(journal.thread_id, journal.turn_id)
  FROM branch_write_journal journal WHERE journal.id = ANY(owner.journal_ids)
  GROUP BY journal.thread_id, journal.turn_id
  ORDER BY journal.thread_id, journal.turn_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER dirty_change_trail_settlement AFTER INSERT OR UPDATE OF state ON branch_push_settlement_outbox
FOR EACH ROW EXECUTE FUNCTION dirty_change_trail_from_settlement();
--> statement-breakpoint
-- Reconstruct dirty owners from authoritative history.
UPDATE turns SET trail_dirty_revision = 1
WHERE (role = 'assistant' AND status IN ('complete', 'cancelled', 'error'))
  OR EXISTS (SELECT 1 FROM branch_write_journal journal WHERE journal.turn_id = turns.id)
  OR EXISTS (SELECT 1 FROM change_trail_shells shell WHERE shell.turn_id = turns.id);
--> statement-breakpoint
UPDATE threads SET trail_dirty_revision = 1
WHERE EXISTS (SELECT 1 FROM turns WHERE turns.thread_id = threads.id AND turns.trail_dirty_revision > 0)
  OR EXISTS (SELECT 1 FROM change_trail_shells shell WHERE shell.thread_id = threads.id);
