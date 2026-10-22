-- migration: no-transaction
-- Online half of 0088: each statement re-runnable and outside any DDL transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branch_tree_changes_moved_folder" ON "branch_tree_changes" USING btree ("moved_folder_id") WHERE "branch_tree_changes"."moved_folder_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_changed_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_changed_turn_id_turns_id_fk";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_tree_facts_documents";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_moved_shape";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_revision_present";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_says_something";
