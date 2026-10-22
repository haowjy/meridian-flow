-- A branch's drafted moves and deletes (PR 3): facts on its `branch_tree_changes` row, beside
-- `created`. Additive columns with constant defaults; `revision`'s sequence default is set
-- apart from its ADD COLUMN, so existing rows keep null rather than rewriting the table. The
-- FKs and CHECKs are NOT VALID, and the folder index is built concurrently; 0089 validates.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE SEQUENCE "public"."branch_tree_change_revision" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" DROP CONSTRAINT "branch_tree_changes_says_something";
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "deleted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved_folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved_root_source_id" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved_name" text;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "moved_extension" text;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "base_version" bigint;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "revision" bigint;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ALTER COLUMN "revision" SET DEFAULT nextval('branch_tree_change_revision');
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "changed_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD COLUMN "changed_turn_id" uuid;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_changed_thread_id_threads_id_fk" FOREIGN KEY ("changed_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_changed_turn_id_turns_id_fk" FOREIGN KEY ("changed_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_tree_facts_documents" CHECK (NOT ("branch_tree_changes"."moved" OR "branch_tree_changes"."deleted") OR "branch_tree_changes"."node_kind" = 'document') NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_moved_shape" CHECK (CASE WHEN "branch_tree_changes"."moved" THEN "branch_tree_changes"."moved_name" IS NOT NULL AND "branch_tree_changes"."moved_extension" IS NOT NULL
        AND ("branch_tree_changes"."moved_folder_id" IS NULL) <> ("branch_tree_changes"."moved_root_source_id" IS NULL)
        ELSE "branch_tree_changes"."moved_folder_id" IS NULL AND "branch_tree_changes"."moved_root_source_id" IS NULL
          AND "branch_tree_changes"."moved_name" IS NULL AND "branch_tree_changes"."moved_extension" IS NULL END) NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_revision_present" CHECK (NOT ("branch_tree_changes"."moved" OR "branch_tree_changes"."deleted") OR "branch_tree_changes"."revision" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_says_something" CHECK ("branch_tree_changes"."created" OR "branch_tree_changes"."moved" OR "branch_tree_changes"."deleted") NOT VALID;
