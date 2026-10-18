-- migration: no-transaction
-- #880 online data half. Each bounded batch commits independently. Re-runnable after interruption.
-- The temporary codec is scoped to collaboration JSON: the keys and opaque ids have one meaning
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
      IF k IN ('branchId','draftBranchId','upstreamBranchId') AND jsonb_typeof(v) = 'string'
        AND v #>> '{}' ~ '^branch_[0-9a-f-]{36}$' THEN
        v := to_jsonb('draft_' || substr(v #>> '{}', 8));
      ELSE
        v := rename_draft_branch_json(v);
      END IF;
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
DECLARE ids text[]; last_id text; next_id text; row_count int; target record;
BEGIN
  LOOP
    SET LOCAL lock_timeout = '2s';
    SELECT array_agg(id ORDER BY id) INTO ids FROM (
      SELECT id FROM document_drafts WHERE id ~ '^branch_[0-9a-f-]{36}$' ORDER BY id LIMIT batch_size FOR UPDATE
    ) batch;
    EXIT WHEN ids IS NULL;
    SET CONSTRAINTS document_drafts_upstream_draft_id_document_drafts_id_fk,
      draft_write_journal_draft_id_document_drafts_id_fk, push_lineage_draft_id_document_drafts_id_fk DEFERRED;
    UPDATE document_drafts SET upstream_draft_id = 'draft_' || substr(upstream_draft_id, 8)
      WHERE upstream_draft_id = ANY(ids);
    UPDATE draft_write_journal SET draft_id = 'draft_' || substr(draft_id, 8) WHERE draft_id = ANY(ids);
    UPDATE push_lineage SET draft_id = 'draft_' || substr(draft_id, 8) WHERE draft_id = ANY(ids);
    UPDATE document_drafts SET id = 'draft_' || substr(id, 8) WHERE id = ANY(ids);
    COMMIT;
  END LOOP;
  -- Keyset iteration transforms each JSON row exactly once, including rows whose keys swap.
  -- The procedure's CALL is one runner chunk, so interruption rolls back its current chunk;
  -- its completed batches must be recognizable without applying the key swap twice.
  FOR target IN SELECT * FROM (VALUES
    ('document_edit_parts','id','origin', 'origin ? ''branchId'''),
    ('document_edit_parts','id','placement', 'placement ? ''branchId'''),
    ('branch_push_settlement_payloads','batch_id','payload', 'payload ? ''draftId'''),
    ('branch_commands','id','result', 'result ? ''draftId''')
  ) t(table_name, id_column, json_column, predicate) LOOP
    last_id := '';
    LOOP
      SET LOCAL lock_timeout = '2s';
      EXECUTE format('WITH batch AS (
        SELECT %1$I AS id FROM %2$I WHERE %1$I::text > $1 AND %3$I IS NOT NULL
          AND (%4$s)
        ORDER BY %1$I::text LIMIT $2 FOR UPDATE
      ), done AS (
        UPDATE %2$I t SET %3$I = rename_draft_branch_json(t.%3$I)%5$s
        FROM batch b WHERE t.%1$I = b.id RETURNING t.%1$I::text AS id
      ) SELECT max(id), count(*) FROM done', target.id_column, target.table_name, target.json_column, target.predicate, CASE WHEN target.table_name = 'branch_commands' THEN ', kind = CASE WHEN kind = ''discard_draft'' THEN ''discard_branch'' ELSE kind END' ELSE '' END)
      INTO next_id, row_count USING last_id, batch_size;
      EXIT WHEN row_count = 0;
      last_id := next_id;
      COMMIT;
    END LOOP;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    WITH batch AS (SELECT ctid FROM thread_shown_links WHERE view LIKE 'draft:%' LIMIT batch_size FOR UPDATE)
    UPDATE thread_shown_links SET view = 'branch:' || substr(view, 7) WHERE ctid IN (SELECT ctid FROM batch);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    EXIT WHEN row_count = 0;
    COMMIT;
  END LOOP;
  LOOP
    SET LOCAL lock_timeout = '2s';
    WITH batch AS (SELECT id FROM branch_commands WHERE kind = 'discard_draft' LIMIT batch_size FOR UPDATE)
    UPDATE branch_commands SET kind = 'discard_branch' WHERE id IN (SELECT id FROM batch);
    GET DIAGNOSTICS row_count = ROW_COUNT;
    EXIT WHEN row_count = 0;
    COMMIT;
  END LOOP;
  UPDATE branch_push_settlement_payloads SET step_kind = 'branch_tree' WHERE step_kind = 'draft_tree';
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
CREATE OR REPLACE PROCEDURE finish_draft_branch_names() LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL lock_timeout = '2s';
  ALTER TABLE "document_drafts" ALTER CONSTRAINT "document_drafts_upstream_draft_id_document_drafts_id_fk" NOT DEFERRABLE;
  ALTER TABLE "draft_write_journal" ALTER CONSTRAINT "draft_write_journal_draft_id_document_drafts_id_fk" NOT DEFERRABLE;
  ALTER TABLE "push_lineage" ALTER CONSTRAINT "push_lineage_draft_id_document_drafts_id_fk" NOT DEFERRABLE;
END $$;
--> statement-breakpoint
CALL finish_draft_branch_names();
--> statement-breakpoint
DROP PROCEDURE finish_draft_branch_names();
--> statement-breakpoint
ALTER TABLE branch_commands VALIDATE CONSTRAINT branch_commands_kind_valid;
