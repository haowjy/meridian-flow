SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "branch_tree_parent_orders" (
	"branch_id" uuid NOT NULL,
	"parent_kind" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"order_policy" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_tree_parent_orders_branch_id_parent_kind_parent_id_pk" PRIMARY KEY("branch_id","parent_kind","parent_id"),
	CONSTRAINT "branch_tree_parent_orders_kind_valid" CHECK ("branch_tree_parent_orders"."parent_kind" IN ('source', 'folder')),
	CONSTRAINT "branch_tree_parent_orders_policy_valid" CHECK ("branch_tree_parent_orders"."order_policy" IN ('default', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved_rank" text;--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "order_policy" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "rank" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "rank" text;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "order_policy" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_tree_parent_orders" ADD CONSTRAINT "branch_tree_parent_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_order_policy_valid" CHECK ("context_sources"."order_policy" IN ('default', 'manual')) NOT VALID;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_order_policy_valid" CHECK ("folders"."order_policy" IN ('default', 'manual')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_parent_orders" VALIDATE CONSTRAINT "branch_tree_parent_orders_branch_id_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "context_sources" VALIDATE CONSTRAINT "context_sources_order_policy_valid";
--> statement-breakpoint
ALTER TABLE "folders" VALIDATE CONSTRAINT "folders_order_policy_valid";
