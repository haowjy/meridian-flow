SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "branch_tree_ranks" (
  "branch_id" uuid NOT NULL,
  "parent_kind" text NOT NULL,
  "parent_id" uuid NOT NULL,
  "node_kind" text NOT NULL,
  "node_id" uuid NOT NULL,
  "rank" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "branch_tree_ranks_branch_id_node_kind_node_id_pk" PRIMARY KEY("branch_id","node_kind","node_id"),
  CONSTRAINT "branch_tree_ranks_parent_kind_valid" CHECK ("branch_tree_ranks"."parent_kind" IN ('source', 'folder')),
  CONSTRAINT "branch_tree_ranks_kind_valid" CHECK ("branch_tree_ranks"."node_kind" IN ('document', 'folder'))
);
--> statement-breakpoint
ALTER TABLE "branch_tree_ranks" ADD CONSTRAINT "branch_tree_ranks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_ranks" VALIDATE CONSTRAINT "branch_tree_ranks_branch_id_branches_id_fk";
--> statement-breakpoint
CREATE INDEX "branch_tree_ranks_parent_rank" ON "branch_tree_ranks" USING btree ("branch_id","parent_kind","parent_id","rank","node_id"); -- migration-lint: skip INDEX_NOT_CONCURRENTLY (table created empty in this migration; no concurrent writes can reach it before commit)
