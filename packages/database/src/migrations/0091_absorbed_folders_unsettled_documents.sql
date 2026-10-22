-- PR 3 phase H: a hidden folder a live folder absorbed names the folder that absorbed it, so
-- history and facts recorded against it resolve there; and the documents a branch has unsettled
-- drafted tree entries on are tracked, so terminal cleanup settles them even after an undo removed
-- their row. The column is nullable with no default (catalog-only); the table is new. The foreign
-- key is added NOT VALID under the lock timeout, then validated after the backfill.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "branch_tree_unsettled" (
	"branch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "branch_tree_unsettled_branch_id_document_id_pk" PRIMARY KEY("branch_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "absorbed_into" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_unsettled" ADD CONSTRAINT "branch_tree_unsettled_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
-- Every document a branch still moves or deletes, or holds a folder for, has unsettled entries.
-- Both sources are small, indexed tables; no scan of document_edits.
INSERT INTO "branch_tree_unsettled" ("branch_id", "document_id")
SELECT "branch_id", "node_id" FROM "branch_tree_changes"
WHERE "node_kind" = 'document' AND ("moved" OR "deleted")
UNION
SELECT "branch_id", "document_id" FROM "branch_tree_folders"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "branch_tree_unsettled" VALIDATE CONSTRAINT "branch_tree_unsettled_branch_id_branches_id_fk";
