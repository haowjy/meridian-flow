-- migration: no-transaction
-- Online half of 0042_work_branch_foundation: build the new indexes beside the old ones, validate
-- 0042's constraints, retire the old indexes once their replacements are valid, then drop the
-- columns 0042 moved off. Every statement is re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_markdown_projections_fts" ON "document_markdown_projections" USING gin (to_tsvector('simple', "markdown"));
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_markdown_projections_trgm" ON "document_markdown_projections" USING gin ("markdown" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "draft_tree_changes_node" ON "draft_tree_changes" USING btree ("node_kind","node_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "drafts_active_origin_work" ON "drafts" USING btree ("origin_work_id","created_at") WHERE "drafts"."status" = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "drafts_project" ON "drafts" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_push_settlement_batches_recovery" ON "branch_push_settlement_batches" USING btree ("available_at","lease_expires_at","created_at") WHERE "branch_push_settlement_batches"."state" = 'pending';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_push_settlement_batches_unresolved" ON "branch_push_settlement_batches" USING btree ("id") WHERE "branch_push_settlement_batches"."state" IN ('pending', 'blocked');
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "draft_commands_work" ON "draft_commands" USING btree ("work_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "draft_commands_settlement_batch" ON "draft_commands" USING btree ("settlement_batch_id") WHERE "draft_commands"."settlement_batch_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_context_location" ON "documents" USING btree ("context_source_id","folder_id","name","extension");
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "documents_context_folder_name_live" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "documents_context_root_name_live" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "documents_context_all_images" ON "documents" USING btree ("context_source_id") WHERE "documents"."file_type" = 'image';
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "folders_context_parent_name_live" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "folders_context_root_name_live" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "folders_hidden_location" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."hidden" AND "folders"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_push_settlement_outbox_document" ON "branch_push_settlement_outbox" USING btree ("document_id");
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "branch_push_settlement_outbox_batch_document" ON "branch_push_settlement_outbox" USING btree ("batch_id","document_id");
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "document_branches_active_draft_document" ON "document_branches" USING btree ("document_id","draft_id") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_branches_active_work_draft_by_draft" ON "document_branches" USING btree ("draft_id","id","generation") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';
--> statement-breakpoint
ALTER TABLE "document_markdown_projections" VALIDATE CONSTRAINT "document_markdown_projections_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" VALIDATE CONSTRAINT "draft_tree_changes_draft_id_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "drafts" VALIDATE CONSTRAINT "drafts_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "drafts" VALIDATE CONSTRAINT "drafts_origin_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "drafts" VALIDATE CONSTRAINT "drafts_origin_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "drafts" VALIDATE CONSTRAINT "drafts_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_holds" VALIDATE CONSTRAINT "branch_push_settlement_holds_batch_id_branch_push_settlement_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_payloads" VALIDATE CONSTRAINT "branch_push_settlement_payloads_batch_id_branch_push_settlement_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" VALIDATE CONSTRAINT "branch_push_settlement_outbox_batch_id_branch_push_settlement_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "document_branches" VALIDATE CONSTRAINT "document_branches_draft_id_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" VALIDATE CONSTRAINT "draft_tree_changes_created_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_tree_changes" VALIDATE CONSTRAINT "draft_tree_changes_created_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_commands" VALIDATE CONSTRAINT "draft_commands_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_commands" VALIDATE CONSTRAINT "draft_commands_draft_id_drafts_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_commands" VALIDATE CONSTRAINT "draft_commands_account_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "draft_commands" VALIDATE CONSTRAINT "draft_commands_settlement_batch_id_branch_push_settlement_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" VALIDATE CONSTRAINT "branch_push_settlement_outbox_counters_valid";
--> statement-breakpoint
ALTER TABLE "document_branches" VALIDATE CONSTRAINT "document_branches_owner_shape";
--> statement-breakpoint
-- The live-path guards above are valid, so the old ones can go.
DROP INDEX CONCURRENTLY IF EXISTS "documents_context_folder_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_context_folder_name_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_context_root_name_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_manifest_context_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_context_images";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_markdown_projection_fts";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "documents_markdown_projection_trgm";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "folders_context_parent_name_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "folders_context_root_name_active";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "branch_push_settlement_outbox_recovery";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "branch_push_settlement_outbox_document_unresolved";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_branches_active_work_draft";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_branches_active_work_draft_by_work";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_branches_deleted_by_work_idx";
--> statement-breakpoint
-- Column drops take ACCESS EXCLUSIVE locks: bound the wait, and only here. They follow the old
-- guards' retirement (those indexes read kind and work_id), so they run in this no-transaction
-- file, where the lint cannot see a session lock_timeout and each drop carries a skip.
SET lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "documents"
  DROP COLUMN IF EXISTS "kind", -- migration-lint: skip DROP_COLUMN (0042 deleted the manifest rows; every remaining row is content)
  DROP COLUMN IF EXISTS "markdown_projection"; -- migration-lint: skip DROP_COLUMN (0042 copied it into document_markdown_projections)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox"
  DROP COLUMN IF EXISTS "settled_join_version", -- migration-lint: skip DROP_COLUMN (retired: the completion transaction owns the join fence)
  DROP COLUMN IF EXISTS "state", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "claim_token", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "claim_epoch", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "claim_kind", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "claimed_at", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "lease_expires_at", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "available_at", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "attempt_count", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "last_error_code", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "last_error", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "blocked_at", -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
  DROP COLUMN IF EXISTS "completed_at"; -- migration-lint: skip DROP_COLUMN (0042 copied it into its batch row)
--> statement-breakpoint
ALTER TABLE "document_branches"
  DROP COLUMN IF EXISTS "work_id", -- migration-lint: skip DROP_COLUMN (0042 keyed every branch by its Work's draft)
  DROP COLUMN IF EXISTS "deleted_by_work_id"; -- migration-lint: skip DROP_COLUMN (0042 reopened the branches a Work delete closed)
--> statement-breakpoint
-- A device's create id that joined a draft's document (additive: a new table and its index).
CREATE TABLE "document_forwards" (
	"from_document_id" uuid PRIMARY KEY NOT NULL,
	"to_document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_to_document_id_documents_id_fk" FOREIGN KEY ("to_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_forwards_to" ON "document_forwards" USING btree ("to_document_id");
--> statement-breakpoint
RESET lock_timeout;
