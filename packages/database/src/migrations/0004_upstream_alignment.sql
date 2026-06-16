CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "works_visibility_valid" CHECK ("works"."visibility" IN ('private', 'shared'))
);
--> statement-breakpoint
ALTER TABLE "turn_blocks" RENAME COLUMN "text_content" TO "model_text";--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_thread_project";--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_thread_session";--> statement-breakpoint
ALTER TABLE "context_sources" DROP CONSTRAINT "context_sources_scope_valid";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_handoff_summary_origin";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_fork_origin_required_fields";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_handoff_origin_required_fields";--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_organic_origin_fields_empty";--> statement-breakpoint
DROP TRIGGER IF EXISTS "context_sources_validate_thread_scope" ON "context_sources";--> statement-breakpoint
DROP TRIGGER IF EXISTS "threads_validate_context_source_scope" ON "threads";--> statement-breakpoint
DROP FUNCTION IF EXISTS "validate_context_source_thread_scope";--> statement-breakpoint
DROP FUNCTION IF EXISTS "validate_thread_context_source_scope";--> statement-breakpoint
ALTER TABLE "event_journal" DROP CONSTRAINT "event_journal_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_thread_id_threads_id_fk";
--> statement-breakpoint
DROP INDEX "context_sources_thread_slug";--> statement-breakpoint
DROP INDEX "context_sources_project_slug";--> statement-breakpoint
DROP INDEX "context_sources_project_sort";--> statement-breakpoint
ALTER TABLE "context_sources" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "context_sources" ADD COLUMN "work_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "is_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_journal" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "work_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "composed_system_prompt" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "system_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "works_project_updated_active" ON "works" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "works_created_by_active" ON "works" USING btree ("created_by_user_id") WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_work_slug" ON "context_sources" USING btree ("work_id","slug") WHERE "context_sources"."work_id" IS NOT NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_personal" ON "projects" USING btree ("user_id") WHERE "projects"."is_personal" = true AND "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "event_journal_turn_id" ON "event_journal" USING btree ("turn_id","created_at") WHERE "event_journal"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_work_updated_active" ON "threads" USING btree ("work_id","updated_at" DESC NULLS LAST) WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."work_id" IS NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "context_sources_project_sort" ON "context_sources" USING btree ("project_id","sort_order") WHERE "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "context_sources" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "handoff_summary";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "request_params";--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL) OR ("context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_work_fk" CHECK ("context_sources"."scope" = 'project' OR "context_sources"."work_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_project_fk" CHECK ("context_sources"."scope" = 'work' OR "context_sources"."work_id" IS NULL);--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work'));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_fork_origin_required_fields" CHECK ("threads"."origin_type" != 'fork' OR ("threads"."kind" = 'primary' AND "threads"."parent_thread_id" IS NOT NULL AND "threads"."origin_turn_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_handoff_origin_required_fields" CHECK ("threads"."origin_type" != 'handoff' OR ("threads"."kind" = 'primary' AND "threads"."parent_thread_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_organic_origin_fields_empty" CHECK ("threads"."origin_type" IS NOT NULL OR ("threads"."parent_thread_id" IS NULL AND "threads"."origin_turn_id" IS NULL AND "threads"."spawn_status" IS NULL));
