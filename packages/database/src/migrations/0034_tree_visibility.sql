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
DROP INDEX "documents_context_folder_active";--> statement-breakpoint
DROP INDEX "documents_context_folder_name_active";--> statement-breakpoint
DROP INDEX "documents_context_root_name_active";--> statement-breakpoint
DROP INDEX "folders_context_parent_name_active";--> statement-breakpoint
DROP INDEX "folders_context_root_name_active";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "location_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
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
CREATE INDEX "link_ahead_holder_bindings_document" ON "link_ahead_holder_bindings" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "draft_tree_changes_location" ON "draft_tree_changes" USING btree ("context_source_id","parent_folder_id","name","extension") WHERE "draft_tree_changes"."context_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "draft_tree_changes_node" ON "draft_tree_changes" USING btree ("node_kind","node_id");--> statement-breakpoint
CREATE INDEX "draft_tree_changes_parent" ON "draft_tree_changes" USING btree ("parent_folder_id") WHERE "draft_tree_changes"."parent_folder_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "drafts_active_origin_work" ON "drafts" USING btree ("origin_work_id","created_at") WHERE "drafts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "drafts_project" ON "drafts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "link_ahead_draft_settlements_draft" ON "link_ahead_draft_settlements" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "link_ahead_draft_settlements_document" ON "link_ahead_draft_settlements" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_context_location" ON "documents" USING btree ("context_source_id","folder_id","name","extension");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_live" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_live" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_parent_name_live" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_root_name_live" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE INDEX "folders_hidden_location" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."hidden" AND "folders"."deleted_at" IS NULL;