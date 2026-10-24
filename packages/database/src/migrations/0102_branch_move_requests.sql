SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "requested_name" text;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "requested_extension" text;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "requested_order" bigint;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_requested_shape"
CHECK (CASE WHEN "moved" THEN ("requested_name" IS NULL AND "requested_extension" IS NULL AND "requested_order" IS NULL)
    OR ("requested_name" IS NOT NULL AND "requested_extension" IS NOT NULL AND "requested_order" IS NOT NULL)
  ELSE "requested_name" IS NULL AND "requested_extension" IS NULL AND "requested_order" IS NULL END) NOT VALID;
