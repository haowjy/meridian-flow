SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "branch_tree_ranks" (
  "branch_id" uuid NOT NULL,
  "node_kind" text NOT NULL,
  "node_id" uuid NOT NULL,
  "rank" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "branch_tree_ranks_branch_id_node_kind_node_id_pk" PRIMARY KEY("branch_id","node_kind","node_id"),
  CONSTRAINT "branch_tree_ranks_kind_valid" CHECK ("branch_tree_ranks"."node_kind" IN ('document', 'folder'))
);
--> statement-breakpoint
ALTER TABLE "branch_tree_ranks" ADD CONSTRAINT "branch_tree_ranks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_ranks" VALIDATE CONSTRAINT "branch_tree_ranks_branch_id_branches_id_fk";
