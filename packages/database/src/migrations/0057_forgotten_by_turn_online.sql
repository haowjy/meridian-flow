-- migration: no-transaction
-- Online half of 0056_forgotten_by_turn: validate the constraint it added NOT VALID, and teach the chat-activity
-- projection that a forgotten turn is never the visible head or its preview (the lineage walks through a
-- forgotten assistant). Re-runnable.
ALTER TABLE "turns" VALIDATE CONSTRAINT "turns_forgotten_by_fk";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION recompute_thread_chat_activity(p_thread_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Lock first, then recompute in a separate statement: under READ COMMITTED a
  -- single UPDATE that waits on a concurrent writer re-checks the thread row
  -- but keeps its pre-wait snapshot of turns, so it could write a stale head.
  -- NO KEY UPDATE stays compatible with the FK KEY SHARE a Work-notice
  -- insert takes on this same thread row (thread-work-lock.ts's lock mode).
  PERFORM 1 FROM threads WHERE id = p_thread_id FOR NO KEY UPDATE;
  -- Canonical visible-conversational-head predicate. Kept in lockstep with
  -- isVisibleConversationalTurn (apps/server/.../domain/visible-conversation-policy.ts):
  -- a subagent_update system turn and an inbox_message or Work-context user turn
  -- never anchor the head; every other assistant/user turn does, and a system
  -- turn otherwise needs a custom block.
  UPDATE threads t SET (conversational_leaf_turn_id, last_activity_at) = (
    SELECT conversational_head.turn_id, COALESCE(conversational_head.activity_at, t.created_at)
    FROM (SELECT 1) AS anchor
    LEFT JOIN LATERAL (
      WITH RECURSIVE lineage AS (
        SELECT tr.id, tr.parent_turn_id, tr.role, tr.metadata, tr.created_at, tr.completed_at,
          tr.forgotten_by_turn_id, 0 AS depth
        FROM turns tr WHERE tr.id = t.active_leaf_turn_id
        UNION ALL
        SELECT parent.id, parent.parent_turn_id, parent.role, parent.metadata,
          parent.created_at, parent.completed_at, parent.forgotten_by_turn_id, l.depth + 1
        FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
        -- Every assistant is visible; this also caps malformed/cyclic lineage.
        -- A forgotten assistant is walked through, not stopped at: it is no longer a visible head.
        WHERE (l.role <> 'assistant' OR l.forgotten_by_turn_id IS NOT NULL) AND l.depth < 10000
      )
      SELECT l.id AS turn_id, COALESCE(l.completed_at, l.created_at) AS activity_at
      FROM lineage l
      WHERE l.forgotten_by_turn_id IS NULL AND NOT EXISTS (
        -- A handed-back writer message left the chat: it never anchors the head or its preview.
        SELECT 1 FROM thread_inbox_messages handed_back
        WHERE handed_back.id = l.id AND handed_back.handed_back_by IS NOT NULL
      ) AND (
        l.role = 'assistant'
        OR (l.role = 'user' AND NOT (
          COALESCE(l.metadata->>'kind', '') = 'inbox_message'
          OR (
            COALESCE(l.metadata->>'kind', '') = 'system_update'
            AND COALESCE(l.metadata->>'section', '') = 'work_context'
          )
        ))
        OR (
          l.role = 'system'
          AND COALESCE(l.metadata->>'kind', '') <> 'subagent_update'
          AND EXISTS (
            SELECT 1 FROM turn_blocks visible_custom_block
            WHERE visible_custom_block.turn_id = l.id
              AND visible_custom_block.block_type = 'custom'
          )
        )
      )
      ORDER BY l.depth LIMIT 1
    ) AS conversational_head ON true
  )
  WHERE t.id = p_thread_id;
END;
$$;
--> statement-breakpoint
-- Forgetting moves the visible head back: recompute the chat's head and activity time. Re-runnable.
CREATE OR REPLACE FUNCTION recompute_thread_chat_activity_from_forget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- CREATE OR REPLACE TRIGGER swaps the trigger in one statement, so a rerun never leaves a window where a
-- stamp gets no recomputation. It takes SHARE ROW EXCLUSIVE on turns, which a long writer transaction can hold
-- off while every later writer queues behind the waiting DDL. So it waits at most 2s per attempt (the lock
-- timeout is local to this one statement) and retries, rather than blocking writes indefinitely. After the last
-- attempt the migration fails with lock_not_available and can simply be rerun.
DO $$
DECLARE
  attempts constant int := 10;
BEGIN
  FOR attempt IN 1..attempts LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      CREATE OR REPLACE TRIGGER recompute_thread_chat_activity_on_forget
      AFTER UPDATE OF forgotten_by_turn_id ON turns
      FOR EACH ROW
      WHEN (NEW.forgotten_by_turn_id IS NOT NULL AND OLD.forgotten_by_turn_id IS NULL)
      EXECUTE FUNCTION recompute_thread_chat_activity_from_forget();
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = attempts THEN RAISE; END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END;
$$;
