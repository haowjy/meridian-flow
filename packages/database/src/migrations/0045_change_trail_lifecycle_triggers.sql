CREATE FUNCTION enlist_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NOT NULL AND NEW.turn_id IS NOT NULL THEN
    INSERT INTO turn_trail_work (journal_id, thread_id, turn_id, branch_id, state)
    VALUES (NEW.id, NEW.thread_id, NEW.turn_id, NEW.branch_id,
      CASE WHEN NEW.status IN ('pushed', 'discarded') THEN 'complete' ELSE 'pending' END);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER enlist_turn_trail_work AFTER INSERT ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION enlist_turn_trail_work();
--> statement-breakpoint
CREATE FUNCTION complete_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('pushed', 'discarded') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE turn_trail_work SET state = 'complete', updated_at = now(), last_error = NULL
    WHERE journal_id = NEW.id;
  ELSIF NEW.status = 'active' AND OLD.status = 'discarded' THEN
    UPDATE turn_trail_work SET state = 'pending', next_attempt_at = now(), updated_at = now()
    WHERE journal_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER complete_turn_trail_work AFTER UPDATE OF status ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION complete_turn_trail_work();
