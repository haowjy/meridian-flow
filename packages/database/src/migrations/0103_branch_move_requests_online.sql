-- migration: no-transaction
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_requested_shape";
