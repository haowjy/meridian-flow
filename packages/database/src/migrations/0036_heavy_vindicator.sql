CREATE TABLE "document_markdown_projections" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_ahead_holder_bindings" (
	"ahead_id" uuid NOT NULL,
	"holder_document_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_ahead_holder_bindings_ahead_id_holder_document_id_pk" PRIMARY KEY("ahead_id","holder_document_id")
);
--> statement-breakpoint
CREATE TABLE "draft_tree_changes" (
	"draft_id" uuid NOT NULL,
	"node_kind" text NOT NULL,
	"node_id" uuid NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"context_source_id" uuid,
	"parent_folder_id" uuid,
	"name" text,
	"extension" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_tree_changes_draft_id_node_kind_node_id_pk" PRIMARY KEY("draft_id","node_kind","node_id"),
	CONSTRAINT "draft_tree_changes_node_kind_valid" CHECK ("draft_tree_changes"."node_kind" IN ('document', 'folder')),
	CONSTRAINT "draft_tree_changes_location_shape" CHECK (("draft_tree_changes"."context_source_id" IS NULL AND "draft_tree_changes"."parent_folder_id" IS NULL AND "draft_tree_changes"."name" IS NULL
        AND "draft_tree_changes"."extension" IS NULL)
      OR ("draft_tree_changes"."context_source_id" IS NOT NULL AND "draft_tree_changes"."name" IS NOT NULL
        AND ("draft_tree_changes"."node_kind" = 'document') = ("draft_tree_changes"."extension" IS NOT NULL))),
	CONSTRAINT "draft_tree_changes_says_something" CHECK ("draft_tree_changes"."created" OR "draft_tree_changes"."context_source_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin_thread_id" uuid,
	"origin_work_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "drafts_status_valid" CHECK ("drafts"."status" IN ('active', 'closed')),
	CONSTRAINT "drafts_closed_shape" CHECK (("drafts"."status" = 'closed') = ("drafts"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "link_ahead_draft_settlements" (
	"ahead_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_ahead_draft_settlements_ahead_id_draft_id_pk" PRIMARY KEY("ahead_id","draft_id")
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claim_epoch" bigint DEFAULT 1 NOT NULL,
	"claim_kind" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"blocked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_batches_state_valid" CHECK ("branch_push_settlement_batches"."state" IN ('pending', 'blocked', 'completed', 'abandoned')),
	CONSTRAINT "branch_push_settlement_batches_terminal_shape" CHECK ((
        ("branch_push_settlement_batches"."state" = 'completed' AND "branch_push_settlement_batches"."completed_at" IS NOT NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'blocked' AND "branch_push_settlement_batches"."blocked_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'abandoned' AND "branch_push_settlement_batches"."abandoned_at" IS NOT NULL AND "branch_push_settlement_batches"."last_error_code" IS NOT NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_batches"."state" = 'pending' AND "branch_push_settlement_batches"."blocked_at" IS NULL AND "branch_push_settlement_batches"."completed_at" IS NULL AND "branch_push_settlement_batches"."abandoned_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_shape" CHECK ("branch_push_settlement_batches"."state" <> 'pending' OR (
        ("branch_push_settlement_batches"."claim_token" IS NOT NULL AND "branch_push_settlement_batches"."claim_kind" IS NOT NULL AND "branch_push_settlement_batches"."claimed_at" IS NOT NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NOT NULL)
        OR ("branch_push_settlement_batches"."claim_token" IS NULL AND "branch_push_settlement_batches"."claim_kind" IS NULL AND "branch_push_settlement_batches"."claimed_at" IS NULL AND "branch_push_settlement_batches"."lease_expires_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_batches_claim_kind_valid" CHECK ("branch_push_settlement_batches"."claim_kind" IS NULL OR "branch_push_settlement_batches"."claim_kind" IN ('warm', 'recovery')),
	CONSTRAINT "branch_push_settlement_batches_counters_valid" CHECK ("branch_push_settlement_batches"."attempt_count" >= 0 AND "branch_push_settlement_batches"."claim_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_holds" (
	"batch_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"document_id" uuid,
	"reason" jsonb NOT NULL,
	"decided_in" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_holds_batch_id_item_key_pk" PRIMARY KEY("batch_id","item_key"),
	CONSTRAINT "branch_push_settlement_holds_decided_in_valid" CHECK ("branch_push_settlement_holds"."decided_in" IN ('check', 'completion'))
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_payloads" (
	"batch_id" uuid NOT NULL,
	"step_kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "branch_push_settlement_payloads_batch_id_step_kind_pk" PRIMARY KEY("batch_id","step_kind")
);
--> statement-breakpoint
-- Each document keeps its Markdown projection: copy it off the identity row before the column drops.
INSERT INTO "document_markdown_projections" ("document_id", "markdown", "updated_at")
SELECT "id", "markdown_projection", "updated_at" FROM "documents";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_state_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_terminal_shape";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_shape";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_claim_kind_valid";--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP CONSTRAINT "branch_push_settlement_outbox_counters_valid";--> statement-breakpoint
DROP INDEX "documents_context_folder_active";--> statement-breakpoint
DROP INDEX "documents_context_folder_name_active";--> statement-breakpoint
DROP INDEX "documents_context_root_name_active";--> statement-breakpoint
DROP INDEX "documents_markdown_projection_fts";--> statement-breakpoint
DROP INDEX "documents_markdown_projection_trgm";--> statement-breakpoint
DROP INDEX "folders_context_parent_name_active";--> statement-breakpoint
DROP INDEX "folders_context_root_name_active";--> statement-breakpoint
DROP INDEX "branch_push_settlement_outbox_recovery";--> statement-breakpoint
DROP INDEX "branch_push_settlement_outbox_document_unresolved";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "location_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
-- Each existing push becomes a settlement batch of one, carrying its claim and terminal state,
-- before the outbox columns that held that state drop below.
INSERT INTO "branch_push_settlement_batches" ("id", "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at")
SELECT md5('branch-push-settlement:' || "push_id")::uuid, "state", "claim_token", "claim_epoch", "claim_kind", "claimed_at", "lease_expires_at", "available_at", "attempt_count", "last_error_code", "last_error", "blocked_at", "completed_at", "created_at", "updated_at"
FROM "branch_push_settlement_outbox";--> statement-breakpoint
UPDATE "branch_push_settlement_outbox" SET "batch_id" = md5('branch-push-settlement:' || "push_id")::uuid; -- migration-lint: skip UPDATE_WITHOUT_WHERE (each existing push becomes a batch of one)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ALTER COLUMN "batch_id" SET NOT NULL; -- migration-lint: skip SET_NOT_NULL_UNSAFE (backfilled above)
--> statement-breakpoint
ALTER TABLE "document_markdown_projections" ADD CONSTRAINT "document_markdown_projections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_holder_bindings" ADD CONSTRAINT "link_ahead_holder_bindings_ahead_id_link_ahead_refs_ahead_id_fk" FOREIGN KEY ("ahead_id") REFERENCES "public"."link_ahead_refs"("ahead_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_holder_bindings" ADD CONSTRAINT "link_ahead_holder_bindings_holder_document_id_documents_id_fk" FOREIGN KEY ("holder_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_holder_bindings" ADD CONSTRAINT "link_ahead_holder_bindings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tree_changes" ADD CONSTRAINT "draft_tree_changes_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_origin_thread_id_threads_id_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_origin_work_id_works_id_fk" FOREIGN KEY ("origin_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_draft_settlements" ADD CONSTRAINT "link_ahead_draft_settlements_ahead_id_link_ahead_refs_ahead_id_fk" FOREIGN KEY ("ahead_id") REFERENCES "public"."link_ahead_refs"("ahead_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_draft_settlements" ADD CONSTRAINT "link_ahead_draft_settlements_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_draft_settlements" ADD CONSTRAINT "link_ahead_draft_settlements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_holds" ADD CONSTRAINT "branch_push_settlement_holds_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_payloads" ADD CONSTRAINT "branch_push_settlement_payloads_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_markdown_projections_fts" ON "document_markdown_projections" USING gin (to_tsvector('simple', "markdown"));--> statement-breakpoint
CREATE INDEX "document_markdown_projections_trgm" ON "document_markdown_projections" USING gin ("markdown" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "link_ahead_holder_bindings_document" ON "link_ahead_holder_bindings" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "draft_tree_changes_location" ON "draft_tree_changes" USING btree ("context_source_id","parent_folder_id","name","extension") WHERE "draft_tree_changes"."context_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "draft_tree_changes_node" ON "draft_tree_changes" USING btree ("node_kind","node_id");--> statement-breakpoint
CREATE INDEX "draft_tree_changes_parent" ON "draft_tree_changes" USING btree ("parent_folder_id") WHERE "draft_tree_changes"."parent_folder_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "drafts_active_origin_work" ON "drafts" USING btree ("origin_work_id","created_at") WHERE "drafts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "drafts_project" ON "drafts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "link_ahead_draft_settlements_draft" ON "link_ahead_draft_settlements" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "link_ahead_draft_settlements_document" ON "link_ahead_draft_settlements" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "branch_push_settlement_batches_recovery" ON "branch_push_settlement_batches" USING btree ("available_at","lease_expires_at","created_at") WHERE "branch_push_settlement_batches"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "branch_push_settlement_batches_unresolved" ON "branch_push_settlement_batches" USING btree ("id") WHERE "branch_push_settlement_batches"."state" IN ('pending', 'blocked');--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_batch_id_branch_push_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."branch_push_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_context_location" ON "documents" USING btree ("context_source_id","folder_id","name","extension");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_live" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_live" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_parent_name_live" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_root_name_live" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE INDEX "folders_hidden_location" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."hidden" AND "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_document" ON "branch_push_settlement_outbox" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_push_settlement_outbox_batch_document" ON "branch_push_settlement_outbox" USING btree ("batch_id","document_id");--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "markdown_projection"; -- migration-lint: skip DROP_COLUMN (copied into document_markdown_projections above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "state"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "settled_join_version"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_token"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_epoch"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claim_kind"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "claimed_at"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "lease_expires_at"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "available_at"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "attempt_count"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "last_error_code"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "last_error"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "blocked_at"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" DROP COLUMN "completed_at"; -- migration-lint: skip DROP_COLUMN (copied into its batch row above)
--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_counters_valid" CHECK ("branch_push_settlement_outbox"."join_version" >= 0 AND "branch_push_settlement_outbox"."classified_join_version" <= "branch_push_settlement_outbox"."join_version");