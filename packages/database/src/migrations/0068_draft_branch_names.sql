-- #880: a branch holds a Work's pending file tree; a draft is one document version.
--> statement-breakpoint
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "drafts" RENAME TO "branches";
--> statement-breakpoint
ALTER TABLE "document_branches" RENAME TO "document_drafts";
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" RENAME TO "branch_tree_changes";
--> statement-breakpoint
ALTER TABLE "draft_commands" RENAME TO "branch_commands";
--> statement-breakpoint
ALTER TABLE "branch_write_journal" RENAME TO "draft_write_journal";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME COLUMN "draft_id" TO "branch_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME COLUMN "upstream_branch_id" TO "upstream_draft_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME COLUMN "draft_id" TO "branch_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME COLUMN "draft_id" TO "branch_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME COLUMN "branch_id" TO "draft_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "push_lineage" RENAME COLUMN "branch_id" TO "draft_id"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "push_lineage" RENAME COLUMN "branch_generation" TO "draft_generation"; -- migration-lint: skip RENAME_COLUMN: metadata-only vocabulary change, bounded lock acquisition; no dual-write shim before launch.
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_actor_user_id_users_id_fk" TO "draft_write_journal_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_branch_id_document_branches_id_fk" TO "draft_write_journal_draft_id_document_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_pkey" TO "draft_write_journal_pkey";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_reviewed_by_users_id_fk" TO "draft_write_journal_reviewed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_source_valid" TO "draft_write_journal_source_valid";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_status_valid" TO "draft_write_journal_status_valid";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_thread_id_threads_id_fk" TO "draft_write_journal_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" RENAME CONSTRAINT "branch_write_journal_turn_id_turns_id_fk" TO "draft_write_journal_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_document_id_documents_id_fk" TO "document_drafts_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_draft_id_drafts_id_fk" TO "document_drafts_branch_id_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_kind_valid" TO "document_drafts_kind_valid";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_owner_shape" TO "document_drafts_owner_shape";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_pkey" TO "document_drafts_pkey";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_status_valid" TO "document_drafts_status_valid";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_thread_id_threads_id_fk" TO "document_drafts_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "document_drafts" RENAME CONSTRAINT "document_branches_upstream_branch_id_document_branches_id_fk" TO "document_drafts_upstream_draft_id_document_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_account_id_users_id_fk" TO "branch_commands_account_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_done_shape" TO "branch_commands_done_shape";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_draft_id_drafts_id_fk" TO "branch_commands_branch_id_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_kind_valid" TO "branch_commands_kind_valid";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_pkey" TO "branch_commands_pkey";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_settlement_batch_id_branch_push_settlement_batch" TO "branch_commands_settlement_batch_id_branch_push_settlement_batc";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_state_valid" TO "branch_commands_state_valid";
--> statement-breakpoint
ALTER TABLE "branch_commands" RENAME CONSTRAINT "draft_commands_work_id_works_id_fk" TO "branch_commands_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_created_thread_id_threads_id_fk" TO "branch_tree_changes_created_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_created_turn_id_turns_id_fk" TO "branch_tree_changes_created_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_draft_id_drafts_id_fk" TO "branch_tree_changes_branch_id_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_draft_id_node_kind_node_id_pk" TO "branch_tree_changes_branch_id_node_kind_node_id_pk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_node_kind_valid" TO "branch_tree_changes_node_kind_valid";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" RENAME CONSTRAINT "draft_tree_changes_says_something" TO "branch_tree_changes_says_something";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_closed_shape" TO "branches_closed_shape";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_created_by_users_id_fk" TO "branches_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_origin_thread_id_threads_id_fk" TO "branches_origin_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_origin_work_id_works_id_fk" TO "branches_origin_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_pkey" TO "branches_pkey";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_project_id_projects_id_fk" TO "branches_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" RENAME CONSTRAINT "drafts_status_valid" TO "branches_status_valid";
--> statement-breakpoint
ALTER TABLE "push_lineage" RENAME CONSTRAINT "push_lineage_branch_id_document_branches_id_fk" TO "push_lineage_draft_id_document_drafts_id_fk";
--> statement-breakpoint
ALTER INDEX "branch_write_journal_branch" RENAME TO "draft_write_journal_draft";
--> statement-breakpoint
ALTER INDEX "branch_write_journal_thread_turn" RENAME TO "draft_write_journal_thread_turn";
--> statement-breakpoint
ALTER INDEX "branch_write_journal_active" RENAME TO "draft_write_journal_active";
--> statement-breakpoint
ALTER INDEX "document_branches_active_thread_peer" RENAME TO "document_drafts_active_thread_peer";
--> statement-breakpoint
ALTER INDEX "document_branches_active_draft_document" RENAME TO "document_drafts_active_branch_document";
--> statement-breakpoint
ALTER INDEX "document_branches_active_work_draft_by_draft" RENAME TO "document_drafts_active_work_draft_by_branch";
--> statement-breakpoint
ALTER INDEX "draft_commands_work" RENAME TO "branch_commands_work";
--> statement-breakpoint
ALTER INDEX "draft_commands_settlement_batch" RENAME TO "branch_commands_settlement_batch";
--> statement-breakpoint
ALTER INDEX "draft_tree_changes_node" RENAME TO "branch_tree_changes_node";
--> statement-breakpoint
ALTER INDEX "drafts_active_origin_work" RENAME TO "branches_active_origin_work";
--> statement-breakpoint
ALTER INDEX "drafts_project" RENAME TO "branches_project";
--> statement-breakpoint
ALTER INDEX "push_lineage_branch" RENAME TO "push_lineage_draft";
--> statement-breakpoint
ALTER SEQUENCE "branch_write_journal_id_seq" RENAME TO "draft_write_journal_id_seq";
--> statement-breakpoint
ALTER TABLE branch_commands DROP CONSTRAINT branch_commands_kind_valid;
--> statement-breakpoint
ALTER TABLE branch_commands ADD CONSTRAINT branch_commands_kind_valid CHECK (kind IN ('apply_items','apply_changes','discard_items','discard_changes','discard_branch')) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION change_trail_owners(
  edit_ids uuid[] DEFAULT '{}', journal_ids bigint[] DEFAULT '{}',
  push_ids bigint[] DEFAULT '{}', direct_thread uuid DEFAULT NULL, direct_turn uuid DEFAULT NULL
) RETURNS TABLE(thread_id uuid, turn_id uuid) LANGUAGE sql STABLE SET jit = off AS $$
  WITH RECURSIVE publications AS (
    SELECT p.thread_id, p.turn_id, p.journal_ids FROM push_lineage p
    WHERE p.id = ANY(change_trail_owners.push_ids)
  ), journals AS (
    SELECT j.thread_id, j.turn_id, j.update_meta FROM draft_write_journal j
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
    -- Renaming the pending draft key changes no placement meaning or trail owners.
    IF TG_OP = 'UPDATE' AND (
      NEW.placement = OLD.placement OR (
        OLD.placement ? 'branchId' AND NOT (OLD.placement ? 'draftId')
        AND NEW.placement = (OLD.placement - 'branchId')
          || jsonb_build_object('draftId', OLD.placement->'branchId')
      )
    ) THEN RETURN NEW; END IF;
    INSERT INTO change_trail_dirty_log(thread_id, turn_id)
      SELECT * FROM change_trail_owners(ARRAY[NEW.edit_id]);
  ELSIF TG_TABLE_NAME = 'draft_write_journal' THEN
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
