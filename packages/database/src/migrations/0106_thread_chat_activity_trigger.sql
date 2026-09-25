-- Single-owner trigger maintenance for threads.last_activity_at and
-- threads.conversational_leaf_turn_id (see domains/threads/.context/CONTEXT.md
-- "Chat activity projection"). No application writer recomputes these columns;
-- every path that can move the visible conversational head (turn creation,
-- turn status/completion, a custom system block, or a direct
-- active_leaf_turn_id move such as a future branch switch) runs through one of
-- the triggers below, which all call the same recompute function.
CREATE FUNCTION recompute_thread_chat_activity(p_thread_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Lock first, then recompute in a separate statement: under READ COMMITTED a
  -- single UPDATE that waits on a concurrent writer re-checks the thread row
  -- but keeps its pre-wait snapshot of turns, so it could write a stale head.
  PERFORM 1 FROM threads WHERE id = p_thread_id FOR UPDATE;
  -- Canonical visible-conversational-head predicate. Kept in lockstep with
  -- isVisibleConversationalTurn (apps/server/.../domain/visible-conversation-policy.ts).
  UPDATE threads t SET (conversational_leaf_turn_id, last_activity_at) = (
    SELECT conversational_head.turn_id, COALESCE(conversational_head.activity_at, t.created_at)
    FROM (SELECT 1) AS anchor
    LEFT JOIN LATERAL (
      WITH RECURSIVE lineage AS (
        SELECT tr.id, tr.parent_turn_id, tr.role, tr.metadata, tr.created_at, tr.completed_at,
          0 AS depth, ARRAY[tr.id]::uuid[] AS path
        FROM turns tr WHERE tr.id = t.active_leaf_turn_id
        UNION ALL
        SELECT parent.id, parent.parent_turn_id, parent.role, parent.metadata,
          parent.created_at, parent.completed_at, l.depth + 1, l.path || parent.id
        FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
        WHERE NOT parent.id = ANY(l.path)
      )
      SELECT l.id AS turn_id, COALESCE(l.completed_at, l.created_at) AS activity_at
      FROM lineage l
      WHERE (
        l.role = 'assistant'
        OR (l.role = 'user' AND NOT (
          COALESCE(l.metadata->>'kind', '') = 'system_update'
          AND COALESCE(l.metadata->>'section', '') IN ('work_context', 'child_report')
        ))
        OR (l.role = 'system' AND EXISTS (
          SELECT 1 FROM turn_blocks visible_custom_block
          WHERE visible_custom_block.turn_id = l.id
            AND visible_custom_block.block_type = 'custom'
        ))
      )
      ORDER BY l.depth LIMIT 1
    ) AS conversational_head ON true
  )
  WHERE t.id = p_thread_id;
END;
$$;
--> statement-breakpoint
-- A thread's own active_leaf_turn_id move (turn creation setting the new leaf,
-- or a future branch switch writing it directly) is the single trigger that
-- must fire regardless of which writer performs it.
CREATE FUNCTION recompute_thread_chat_activity_from_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_active_leaf
AFTER UPDATE OF active_leaf_turn_id ON threads
FOR EACH ROW
WHEN (NEW.active_leaf_turn_id IS DISTINCT FROM OLD.active_leaf_turn_id)
EXECUTE FUNCTION recompute_thread_chat_activity_from_thread();
--> statement-breakpoint
-- A turn's creation, or a change to a column the head predicate reads
-- (role/metadata for visibility, status/completed_at for the activity
-- timestamp), can change which turn is the visible head.
CREATE FUNCTION recompute_thread_chat_activity_from_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_turn
AFTER INSERT OR UPDATE OF role, metadata, status, completed_at ON turns
FOR EACH ROW EXECUTE FUNCTION recompute_thread_chat_activity_from_turn();
--> statement-breakpoint
-- A system turn becomes (or stops being) visible only through a custom block.
-- The WHEN clauses keep every other block write (streaming text/tool content,
-- and non-custom upserts) from invoking the function at all.
CREATE FUNCTION recompute_thread_chat_activity_from_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_thread_id uuid;
BEGIN
  SELECT thread_id INTO v_thread_id FROM turns WHERE id = NEW.turn_id;
  IF v_thread_id IS NOT NULL THEN
    PERFORM recompute_thread_chat_activity(v_thread_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_block_insert
AFTER INSERT ON turn_blocks
FOR EACH ROW
WHEN (NEW.block_type = 'custom')
EXECUTE FUNCTION recompute_thread_chat_activity_from_block_insert();
--> statement-breakpoint
CREATE FUNCTION recompute_thread_chat_activity_from_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new_thread_id uuid;
  v_old_thread_id uuid;
BEGIN
  SELECT thread_id INTO v_new_thread_id FROM turns WHERE id = NEW.turn_id;
  IF v_new_thread_id IS NOT NULL THEN
    PERFORM recompute_thread_chat_activity(v_new_thread_id);
  END IF;
  IF OLD.turn_id IS DISTINCT FROM NEW.turn_id THEN
    SELECT thread_id INTO v_old_thread_id FROM turns WHERE id = OLD.turn_id;
    IF v_old_thread_id IS NOT NULL AND v_old_thread_id IS DISTINCT FROM v_new_thread_id THEN
      PERFORM recompute_thread_chat_activity(v_old_thread_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_block_update
AFTER UPDATE OF block_type, turn_id ON turn_blocks
FOR EACH ROW
WHEN (NEW.block_type = 'custom' OR OLD.block_type = 'custom')
EXECUTE FUNCTION recompute_thread_chat_activity_from_block_update();
