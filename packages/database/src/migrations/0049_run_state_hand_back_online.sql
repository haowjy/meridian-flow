-- migration: no-transaction
-- Online half of 0048_run_state_hand_back: validate the constraints it added NOT VALID, build the
-- partial index that names a chat's handed-back messages (every conversation read joins it), and teach
-- the chat-activity projection that a handed-back message is not the visible head. Re-runnable.
ALTER TABLE "thread_hand_backs" VALIDATE CONSTRAINT "thread_hand_backs_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_handed_back_by_fk";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" VALIDATE CONSTRAINT "thread_inbox_messages_hand_back";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "thread_inbox_messages_handed_back" ON "thread_inbox_messages" USING btree ("thread_id") WHERE "thread_inbox_messages"."handed_back_by" IS NOT NULL;
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
          0 AS depth
        FROM turns tr WHERE tr.id = t.active_leaf_turn_id
        UNION ALL
        SELECT parent.id, parent.parent_turn_id, parent.role, parent.metadata,
          parent.created_at, parent.completed_at, l.depth + 1
        FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
        -- Every assistant is visible; this also caps malformed/cyclic lineage.
        WHERE l.role <> 'assistant' AND l.depth < 10000
      )
      SELECT l.id AS turn_id, COALESCE(l.completed_at, l.created_at) AS activity_at
      FROM lineage l
      WHERE NOT EXISTS (
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
-- A hand-back moves the visible head back: recompute the chat's head and activity time. Re-runnable.
CREATE OR REPLACE FUNCTION recompute_thread_chat_activity_from_hand_back() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recompute_thread_chat_activity_on_hand_back ON thread_inbox_messages;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_hand_back
AFTER UPDATE OF handed_back_by ON thread_inbox_messages
FOR EACH ROW
WHEN (NEW.handed_back_by IS NOT NULL AND OLD.handed_back_by IS NULL)
EXECUTE FUNCTION recompute_thread_chat_activity_from_hand_back();
