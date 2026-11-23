CREATE FUNCTION public.enforce_mcp_pin_insert_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM mcp_connections WHERE id = OLD.connection_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'MCP pins are insert-only'
    USING ERRCODE = '23514', CONSTRAINT = 'mcp_pins_insert_only';
END;
$$;

CREATE FUNCTION public.enforce_prompt_bake_insert_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM threads WHERE id = OLD.owner_thread_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Prompt bakes are insert-only'
    USING ERRCODE = '23514', CONSTRAINT = 'prompt_bakes_insert_only';
END;
$$;

CREATE FUNCTION public.enforce_prompt_bake_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_value jsonb;
  new_value jsonb;
BEGIN
  old_value := to_jsonb(OLD) -> TG_ARGV[0];
  new_value := to_jsonb(NEW) -> TG_ARGV[0];
  IF old_value IS DISTINCT FROM 'null'::jsonb AND new_value IS DISTINCT FROM old_value THEN
    RAISE EXCEPTION 'Prompt bake pointer is write-once'
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[1];
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_turn_position_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'Turn position is write-once'
      USING ERRCODE = '23514', CONSTRAINT = 'turns_position_write_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity(p_thread_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_block_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_block_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_forget() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_hand_back() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_turn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

ALTER TABLE public.document_block_rooms SET (fillfactor = 90);

CREATE TRIGGER mcp_pins_insert_only BEFORE DELETE OR UPDATE ON public.mcp_pins FOR EACH ROW EXECUTE FUNCTION public.enforce_mcp_pin_insert_only();

CREATE TRIGGER prompt_bakes_insert_only BEFORE DELETE OR UPDATE ON public.prompt_bakes FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_insert_only();

CREATE TRIGGER recompute_thread_chat_activity_on_active_leaf AFTER UPDATE OF active_leaf_turn_id ON public.threads FOR EACH ROW WHEN ((new.active_leaf_turn_id IS DISTINCT FROM old.active_leaf_turn_id)) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_thread();

CREATE TRIGGER recompute_thread_chat_activity_on_block_insert AFTER INSERT ON public.turn_blocks FOR EACH ROW WHEN ((new.block_type = 'custom'::text)) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_block_insert();

CREATE TRIGGER recompute_thread_chat_activity_on_block_update AFTER UPDATE OF block_type, turn_id ON public.turn_blocks FOR EACH ROW WHEN (((new.block_type = 'custom'::text) OR (old.block_type = 'custom'::text))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_block_update();

CREATE TRIGGER recompute_thread_chat_activity_on_forget AFTER UPDATE OF forgotten_by_turn_id ON public.turns FOR EACH ROW WHEN (((new.forgotten_by_turn_id IS NOT NULL) AND (old.forgotten_by_turn_id IS NULL))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_forget();

CREATE TRIGGER recompute_thread_chat_activity_on_hand_back AFTER UPDATE OF handed_back_by ON public.thread_inbox_messages FOR EACH ROW WHEN (((new.handed_back_by IS NOT NULL) AND (old.handed_back_by IS NULL))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_hand_back();

CREATE TRIGGER recompute_thread_chat_activity_on_turn AFTER INSERT OR UPDATE OF role, metadata, status, completed_at ON public.turns FOR EACH ROW EXECUTE FUNCTION public.recompute_thread_chat_activity_from_turn();

CREATE TRIGGER threads_initial_prompt_bake_write_once BEFORE UPDATE OF initial_prompt_bake_id ON public.threads FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_write_once('initial_prompt_bake_id', 'threads_initial_prompt_bake_write_once');

CREATE TRIGGER turns_position_write_once BEFORE UPDATE OF "position" ON public.turns FOR EACH ROW EXECUTE FUNCTION public.enforce_turn_position_write_once();

CREATE TRIGGER turns_prompt_bake_write_once BEFORE UPDATE OF prompt_bake_id ON public.turns FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_write_once('prompt_bake_id', 'turns_prompt_bake_write_once');

ALTER TABLE ONLY public.mcp_connections
    ALTER CONSTRAINT mcp_connections_current_pin_id_mcp_pins_id_fk DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.threads
    ALTER CONSTRAINT threads_initial_prompt_bake_id_prompt_bakes_id_fk DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.threads
    ALTER CONSTRAINT threads_origin_turn_id_turns_id_fk DEFERRABLE;

ALTER TABLE ONLY public.turns
    ALTER CONSTRAINT turns_prompt_bake_id_prompt_bakes_id_fk DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.tree_nodes
    ALTER CONSTRAINT tree_nodes_parent_in_source DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.works
    ALTER CONSTRAINT works_draft_id_drafts_id_fk DEFERRABLE;

CREATE FUNCTION public.create_tree_list() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- A project's or an account's tree list exists from the moment its owner does: the identity
  -- its rows (`tree_nodes`, `tree_node_ids`) hang from. The list itself is in `document_snapshots`.
  IF TG_TABLE_NAME = 'projects' THEN
    INSERT INTO tree_lists (id, project_id) VALUES (NEW.tree_list_id, NEW.id);
  ELSE
    INSERT INTO tree_lists (id, user_id) VALUES (NEW.tree_list_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_create_tree_list AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION public.create_tree_list();

CREATE TRIGGER users_create_tree_list AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.create_tree_list();

CREATE FUNCTION public.delete_room_snapshots() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- `document_snapshots` is keyed by room name, with no foreign key: a room's rows go with
  -- what the room holds. A tree list's room is `tree:<tree_list_id>`.
  IF TG_TABLE_NAME = 'documents' THEN
    DELETE FROM document_snapshots WHERE room_key = 'live:' || OLD.id::text;
  ELSIF TG_TABLE_NAME = 'document_forks' THEN
    DELETE FROM document_snapshots WHERE room_key = 'fork:' || OLD.draft_id || ':' || OLD.document_id::text;
  ELSE
    DELETE FROM document_snapshots WHERE room_key = 'tree:' || OLD.tree_list_id::text;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER documents_delete_room_snapshots AFTER DELETE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.delete_room_snapshots();

CREATE TRIGGER document_forks_delete_room_snapshots AFTER DELETE ON public.document_forks FOR EACH ROW EXECUTE FUNCTION public.delete_room_snapshots();

CREATE TRIGGER projects_delete_room_snapshots AFTER DELETE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.delete_room_snapshots();

CREATE TRIGGER users_delete_room_snapshots AFTER DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.delete_room_snapshots();

CREATE FUNCTION public.create_account_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- An account's home folder has its source from the moment the account exists.
  INSERT INTO context_sources (user_id, slug, scope) VALUES (NEW.id, 'user', 'account');
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_create_account_source AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.create_account_source();

CREATE FUNCTION public.mint_named_draft() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  names_draft boolean;
  draft_project uuid;
BEGIN
  -- A named Work and a root chat each name their draft, minted with them in the same insert
  -- (`threads_draft_on_root`, `works_draft_unless_no_work`). The client may send the id it
  -- minted, so it can type into the draft before the create returns.
  IF TG_TABLE_NAME = 'works' THEN
    names_draft := NOT NEW.is_no_work;
  ELSE
    names_draft := NEW.root_thread_id = NEW.id;
  END IF;
  -- A retried create whose row exists conflicts or does nothing: it mints nothing.
  IF NOT names_draft OR EXISTS (SELECT 1 FROM works WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM threads WHERE id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF NEW.draft_id IS NULL THEN
    NEW.draft_id := (
      SELECT string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz', 1 + floor(random() * 36)::int, 1), '')
      FROM generate_series(1, 12)
    );
  END IF;
  INSERT INTO drafts (id, project_id, created_by)
    VALUES (NEW.draft_id, NEW.project_id, NEW.created_by_user_id)
    ON CONFLICT (id) DO NOTHING;
  SELECT project_id INTO draft_project FROM drafts WHERE id = NEW.draft_id;
  IF draft_project <> NEW.project_id THEN
    RAISE EXCEPTION 'draft % belongs to another project', NEW.draft_id USING ERRCODE = 'check_violation';
  END IF;
  -- One row names a draft: the two unique columns cannot see each other.
  IF EXISTS (SELECT 1 FROM works WHERE draft_id = NEW.draft_id)
    OR EXISTS (SELECT 1 FROM threads WHERE draft_id = NEW.draft_id) THEN
    RAISE EXCEPTION 'draft % is named by another row', NEW.draft_id USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER works_mint_draft BEFORE INSERT ON public.works FOR EACH ROW EXECUTE FUNCTION public.mint_named_draft();

CREATE TRIGGER threads_mint_draft BEFORE INSERT ON public.threads FOR EACH ROW EXECUTE FUNCTION public.mint_named_draft();
