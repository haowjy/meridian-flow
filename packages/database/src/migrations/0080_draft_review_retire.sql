SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- Retained text and all historical Apply evidence were committed by 0078. The
-- online replacement indexes are valid before the legacy columns are retired.
ALTER TABLE "branch_commands" DROP CONSTRAINT "branch_commands_settlement_batch_id_branch_push_settlement_batc";
--> statement-breakpoint
ALTER TABLE "document_edit_parts" DROP CONSTRAINT "document_edit_parts_placement_valid";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP CONSTRAINT "draft_write_journal_status_valid";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP CONSTRAINT "draft_write_journal_reviewed_by_users_id_fk";
--> statement-breakpoint
-- The trigger's UPDATE OF list is a catalog dependency even after 0076 changed its body.
DROP TRIGGER capture_change_trail_part ON document_edit_parts;
--> statement-breakpoint
CREATE TRIGGER capture_change_trail_part AFTER INSERT ON document_edit_parts
  FOR EACH ROW EXECUTE FUNCTION capture_change_trail_signal();
--> statement-breakpoint
ALTER TABLE "document_edit_parts" DROP COLUMN "placement";
--> statement-breakpoint
ALTER TABLE "branch_commands" DROP COLUMN "settlement_batch_id";
--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "blocking";
--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "live_cut";
--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "discarded_state_vector";
--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "generation";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP COLUMN "generation";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP COLUMN "draft_base_update_seq";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP COLUMN "pushed_at";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP COLUMN "reviewed_by";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" DROP COLUMN "reviewed_at";
--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "draft_generation";
--> statement-breakpoint
ALTER TABLE "push_lineage" DROP COLUMN "journal_ids";
--> statement-breakpoint
ALTER TABLE "draft_write_journal" ADD CONSTRAINT "draft_write_journal_status_valid" CHECK ("draft_write_journal"."status" IN ('active', 'rollback_pending')) NOT VALID;
--> statement-breakpoint
DROP TABLE "branch_push_outbox_updates";
--> statement-breakpoint
DROP TABLE "branch_push_settlement_outbox";
--> statement-breakpoint
DROP TABLE "branch_push_settlement_holds";
--> statement-breakpoint
DROP TABLE "branch_push_settlement_payloads";
--> statement-breakpoint
DROP TABLE "branch_push_settlement_batches";
--> statement-breakpoint
ALTER INDEX "document_drafts_active_work_draft_by_branch_next" RENAME TO "document_drafts_active_work_draft_by_branch";
--> statement-breakpoint
ALTER INDEX "draft_write_journal_draft_next" RENAME TO "draft_write_journal_draft";
--> statement-breakpoint
ALTER INDEX "draft_write_journal_active_next" RENAME TO "draft_write_journal_active";
--> statement-breakpoint
ALTER INDEX "push_lineage_draft_next" RENAME TO "push_lineage_draft";
