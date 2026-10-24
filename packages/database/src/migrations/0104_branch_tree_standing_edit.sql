SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "standing_tree_edit_id" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_standing_tree_edit_id_document_edits_id_fk"
FOREIGN KEY ("standing_tree_edit_id") REFERENCES "public"."document_edits"("id") ON DELETE set null ON UPDATE no action NOT VALID;
