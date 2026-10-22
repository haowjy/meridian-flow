-- Separate from 0084 so the scan takes no ACCESS EXCLUSIVE lock.
ALTER TABLE "document_edits" VALIDATE CONSTRAINT "document_edits_tree_change_valid";
