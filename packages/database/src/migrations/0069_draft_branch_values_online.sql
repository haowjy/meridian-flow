-- migration: no-transaction
-- #880 online data half. Each bounded batch commits independently. Re-runnable after interruption.
-- The temporary codec is scoped to collaboration JSON: the keys have one meaning
-- there. It never visits document text, chat messages, or model tool input.
CREATE OR REPLACE FUNCTION rename_draft_branch_json(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb; k text; v jsonb; new_key text;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    result := '{}'::jsonb;
    FOR k, v IN SELECT * FROM jsonb_each(value) LOOP
      new_key := CASE k WHEN 'draftId' THEN 'branchId' WHEN 'branchId' THEN 'draftId'
        WHEN 'draftBranchId' THEN 'draftId' WHEN 'branchGeneration' THEN 'draftGeneration'
        WHEN 'branchGenerationToken' THEN 'draftGenerationToken'
        WHEN 'upstreamBranchId' THEN 'upstreamDraftId' ELSE k END;
      v := rename_draft_branch_json(v);
      result := result || jsonb_build_object(new_key, v);
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(value) = 'array' THEN
    RETURN coalesce((SELECT jsonb_agg(rename_draft_branch_json(element) ORDER BY ordinality)
      FROM jsonb_array_elements(value) WITH ORDINALITY a(element, ordinality)), '[]'::jsonb);

  END IF;
  RETURN value;
END $$;
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE rename_draft_branch_values(batch_size int) LANGUAGE plpgsql AS $$
DECLARE
  part_cursor bigint; part_next bigint; part_ids bigint[];
  command_cursor uuid; command_next uuid; command_ids uuid[];
  batch_cursor uuid; step_cursor text; settlement_page branch_push_settlement_payloads[];
  link_thread uuid;
  link_document uuid;
  link_digest text; link_turn uuid; link_page thread_shown_links[];
  item record; new_view text; new_digest text;
BEGIN
  -- Durable IDs are opaque: retaining them avoids unbounded FK fanout and broken JSON references.
  -- Page over ALL rows in native primary-key order, then test the version marker. Filtering
  -- before LIMIT could scan an entire retained history to fill one batch of old rows.
  LOOP
    SET LOCAL lock_timeout = '2s';
    -- No key value is reserved: the first page has no lower bound.
    IF part_cursor IS NULL THEN
      SELECT max(id), array_agg(id) INTO part_next, part_ids FROM (
        SELECT id FROM document_edit_parts ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT max(id), array_agg(id) INTO part_next, part_ids FROM (
        SELECT id FROM document_edit_parts WHERE id > part_cursor ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN part_next IS NULL;
    UPDATE document_edit_parts SET
      origin = CASE WHEN origin ? 'branchId' THEN rename_draft_branch_json(origin) ELSE origin END,
      placement = CASE WHEN placement ? 'branchId' THEN rename_draft_branch_json(placement) ELSE placement END
    WHERE id = ANY(part_ids) AND (origin ? 'branchId' OR placement ? 'branchId');
    part_cursor := part_next;
    COMMIT;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF batch_cursor IS NULL THEN
      SELECT array_agg(page) INTO settlement_page FROM (
        SELECT * FROM branch_push_settlement_payloads
        ORDER BY batch_id, step_kind LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(page) INTO settlement_page FROM (
        SELECT * FROM branch_push_settlement_payloads
        WHERE (batch_id, step_kind) > (batch_cursor, step_cursor)
        ORDER BY batch_id, step_kind LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN settlement_page IS NULL;
    FOREACH item IN ARRAY settlement_page LOOP
      batch_cursor := item.batch_id; step_cursor := item.step_kind;
      IF item.step_kind = 'draft_tree' THEN
        UPDATE branch_push_settlement_payloads SET payload = rename_draft_branch_json(payload), step_kind = 'branch_tree'
        WHERE batch_id = item.batch_id AND step_kind = item.step_kind;
      END IF;
    END LOOP;
    COMMIT;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    IF command_cursor IS NULL THEN
      SELECT array_agg(id ORDER BY id) INTO command_ids FROM (
        SELECT id FROM branch_commands ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(id ORDER BY id) INTO command_ids FROM (
        SELECT id FROM branch_commands WHERE id > command_cursor ORDER BY id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN command_ids IS NULL;
    command_next := command_ids[array_length(command_ids, 1)];
    UPDATE branch_commands SET
      result = CASE WHEN result ? 'draftId' THEN rename_draft_branch_json(result) ELSE result END,
      kind = CASE WHEN kind = 'discard_draft' THEN 'discard_branch' ELSE kind END
    WHERE id = ANY(command_ids) AND (result ? 'draftId' OR kind = 'discard_draft');
    command_cursor := command_next;
    COMMIT;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    -- A changed digest can move a showing onto a later page; its new view makes that visit a no-op.
    IF link_thread IS NULL THEN
      SELECT array_agg(page) INTO link_page FROM (
        SELECT * FROM thread_shown_links
        ORDER BY thread_id, document_id, showing_digest, turn_id LIMIT batch_size FOR UPDATE
      ) page;
    ELSE
      SELECT array_agg(page) INTO link_page FROM (
        SELECT * FROM thread_shown_links
        WHERE (thread_id, document_id, showing_digest, turn_id) > (link_thread, link_document, link_digest, link_turn)
        ORDER BY thread_id, document_id, showing_digest, turn_id LIMIT batch_size FOR UPDATE
      ) page;
    END IF;
    EXIT WHEN link_page IS NULL;
    FOREACH item IN ARRAY link_page LOOP
      link_thread := item.thread_id; link_document := item.document_id;
      link_digest := item.showing_digest; link_turn := item.turn_id;
      IF item.view NOT LIKE 'draft:%' THEN CONTINUE; END IF;
      new_view := 'branch:' || substr(item.view, 7);
      -- array_to_json(text[]) has the compact JSON.stringify string-array encoding, unlike jsonb::text.
      new_digest := encode(sha256(convert_to(array_to_json(ARRAY[item.ref, item.address, item.holder_uri, new_view])::text, 'UTF8')), 'hex');
      DELETE FROM thread_shown_links WHERE thread_id = item.thread_id AND document_id = item.document_id
        AND showing_digest = item.showing_digest AND turn_id = item.turn_id;
      INSERT INTO thread_shown_links (thread_id, document_id, showing_digest, turn_id, ref, address, holder_uri, view, seq)
      VALUES (item.thread_id, item.document_id, new_digest, item.turn_id, item.ref, item.address, item.holder_uri, new_view, item.seq)
      ON CONFLICT (thread_id, document_id, showing_digest, turn_id) DO UPDATE
        SET seq = greatest(thread_shown_links.seq, excluded.seq)
        WHERE thread_shown_links.ref = excluded.ref AND thread_shown_links.address = excluded.address
          AND thread_shown_links.holder_uri = excluded.holder_uri AND thread_shown_links.view = excluded.view;
      IF NOT FOUND THEN RAISE EXCEPTION 'shown-link digest collision'; END IF;
    END LOOP;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL rename_draft_branch_values(500);
--> statement-breakpoint
DROP PROCEDURE rename_draft_branch_values(int);
--> statement-breakpoint
DROP FUNCTION rename_draft_branch_json(jsonb);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edit_parts_pending_v2" ON "document_edit_parts" USING btree ((placement->>'draftId'), (placement->>'generation')) WHERE placement->>'kind' = 'pending';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_edit_parts_pending_idx";
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_edit_parts_pending_v2') IS NOT NULL THEN
    ALTER INDEX document_edit_parts_pending_v2 RENAME TO document_edit_parts_pending_idx;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE branch_commands VALIDATE CONSTRAINT branch_commands_kind_valid;
