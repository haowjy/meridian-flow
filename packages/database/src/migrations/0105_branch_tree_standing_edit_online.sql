-- migration: no-transaction
ALTER TABLE "branch_tree_changes" VALIDATE CONSTRAINT "branch_tree_changes_standing_tree_edit_id_document_edits_id_fk";
