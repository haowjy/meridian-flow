-- #939 phase 4 (D33): the change-trail dirty signals leave the keystroke's branch row hold.
--
-- The trail is the per-thread, per-turn record of document changes a chat shows; the triggers
-- from 0041/0044 append (thread, turn) owners to `change_trail_dirty_log`, and the trail
-- aggregate reconciles them later. Journal and receipt inserts run inside an append's
-- `document_branches` row lock, three per keystroke, so the signal's cost is the writer's hold.
--
-- The cost was not the lookups (well under 1 ms) but JIT: the recursive `edits` CTE has an
-- unbounded row estimate, so the plan crosses `jit_above_cost`, and later the inline/optimize
-- thresholds, and every call compiled LLVM code (15-30 ms per call on an empty database, hundreds
-- of milliseconds once the tables grow). The owner query never touches more than a handful of
-- rows, so it runs with JIT off. Its journal lookup also drops the `id = ANY(...) OR EXISTS`
-- filter, which can only scan the journal, for one primary-key lookup over the requested and the
-- publications' journal ids. The owners it returns are unchanged.
--
-- Two inserts that cannot have owners return before the query: a journal row with no thread and
-- no `documentEdit` link, and a receipt with no thread and no parts yet (every writer keystroke
-- receipt). A writer journal row links its receipt, which is inserted after it, so it still runs
-- the (now cheap) query.
--
-- Function replacement only: no table lock, nothing to rewrite.
CREATE OR REPLACE FUNCTION change_trail_owners(
  edit_ids uuid[] DEFAULT '{}', journal_ids bigint[] DEFAULT '{}',
  push_ids bigint[] DEFAULT '{}', direct_thread uuid DEFAULT NULL, direct_turn uuid DEFAULT NULL
) RETURNS TABLE(thread_id uuid, turn_id uuid) LANGUAGE sql STABLE SET jit = off AS $$
  WITH RECURSIVE publications AS (
    SELECT p.thread_id, p.turn_id, p.journal_ids FROM push_lineage p
    WHERE p.id = ANY(change_trail_owners.push_ids)
  ), journals AS (
    SELECT j.thread_id, j.turn_id, j.update_meta FROM branch_write_journal j
    WHERE j.id = ANY(
      change_trail_owners.journal_ids || ARRAY(SELECT unnest(p.journal_ids) FROM publications p)
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
CREATE OR REPLACE FUNCTION capture_change_trail_signal() RETURNS trigger LANGUAGE plpgsql AS $$
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
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.edit_id]);
  ELSIF TG_TABLE_NAME = 'branch_write_journal' THEN
    -- Owners come only from the row's thread and its `documentEdit` link.
    IF NEW.thread_id IS NULL AND NEW.update_meta->'documentEdit'->>'editId' IS NULL THEN
      RETURN NEW;
    END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'push_lineage' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.id]);
  ELSIF TG_TABLE_NAME = 'branch_push_settlement_outbox' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY[NEW.push_id]);
  ELSIF TG_TABLE_NAME = 'branch_push_settlement_batches' THEN
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners('{}', '{}', ARRAY(
        SELECT o.push_id FROM branch_push_settlement_outbox o WHERE o.batch_id = NEW.id
      ));
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
