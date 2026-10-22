-- The folders a branch's drafted moves held for a document until its entries settle (PR 3
-- gate EF): a new table, so creating it rewrites nothing. The foreign key is added NOT VALID
-- under the lock timeout, which bounds the SHARE ROW EXCLUSIVE lock it takes on branches, then
-- validated: the new table is empty, so validation and its index build scan nothing.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "branch_tree_folders" (
	"branch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	CONSTRAINT "branch_tree_folders_branch_id_document_id_folder_id_pk" PRIMARY KEY("branch_id","document_id","folder_id")
);
--> statement-breakpoint
ALTER TABLE "branch_tree_folders" ADD CONSTRAINT "branch_tree_folders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_folders" VALIDATE CONSTRAINT "branch_tree_folders_branch_id_branches_id_fk";
--> statement-breakpoint
CREATE INDEX "branch_tree_folders_folder" ON "branch_tree_folders" USING btree ("folder_id");
