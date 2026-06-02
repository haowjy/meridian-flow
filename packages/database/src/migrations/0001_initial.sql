CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "credit_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"original_amount_millicredits" bigint NOT NULL,
	"remaining_millicredits" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"stripe_session_id" text,
	"grant_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_lots_original_positive" CHECK ("credit_lots"."original_amount_millicredits" > 0),
	CONSTRAINT "credit_lots_source_type" CHECK ("credit_lots"."source_type" IN ('purchase', 'grant', 'subscription', 'debt')),
	CONSTRAINT "credit_lots_purchase_stripe" CHECK ("credit_lots"."source_type" = 'purchase' OR "credit_lots"."stripe_session_id" IS NULL),
	CONSTRAINT "credit_lots_grant_reason" CHECK ("credit_lots"."source_type" = 'grant' OR "credit_lots"."grant_reason" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_type" text NOT NULL,
	"amount_millicredits" bigint NOT NULL,
	"lot_id" uuid,
	"consumption_group_id" uuid,
	"usage_event_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_nonzero" CHECK ("credit_transactions"."amount_millicredits" != 0),
	CONSTRAINT "credit_transactions_consumption_group" CHECK ("credit_transactions"."transaction_type" != 'consumption' OR "credit_transactions"."consumption_group_id" IS NOT NULL),
	CONSTRAINT "credit_transactions_consumption_usage_event" CHECK ("credit_transactions"."transaction_type" != 'consumption' OR "credit_transactions"."usage_event_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"plan" text DEFAULT 'pro' NOT NULL,
	"status" text NOT NULL,
	"credits_per_period" bigint NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "context_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"adapter_type" text DEFAULT 'local' NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_state" jsonb,
	"description" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "context_sources_scope_thread_project" CHECK ("context_sources"."scope" = 'session' OR "context_sources"."thread_id" IS NULL),
	CONSTRAINT "context_sources_scope_thread_session" CHECK ("context_sources"."scope" = 'project' OR "context_sources"."thread_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_source_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"extension" text DEFAULT 'md' NOT NULL,
	"file_type" text DEFAULT 'markdown' NOT NULL,
	"description" text,
	"storage_url" text,
	"mime_type" text,
	"size_bytes" bigint,
	"markdown_projection" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_size_bytes_nonneg" CHECK ("documents"."size_bytes" IS NULL OR "documents"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_source_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"system_prompt" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"usage_breakdown" jsonb DEFAULT '{}'::jsonb,
	"cost_usd" numeric(12, 6),
	"millicredits" bigint,
	"stop_reason" text,
	"request_params" jsonb,
	"response_metadata" jsonb,
	"latency_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread_documents" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"relationship" text DEFAULT 'editing' NOT NULL,
	"first_touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_documents_thread_id_document_id_pk" PRIMARY KEY("thread_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "thread_user_state" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "thread_user_state_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_agent_id" uuid,
	"working_state" jsonb,
	"parent_thread_id" uuid,
	"origin_turn_id" uuid,
	"origin_type" text,
	"handoff_summary" text,
	"spawn_status" text,
	"spawn_result" jsonb,
	"spawn_depth" integer DEFAULT 0 NOT NULL,
	"active_leaf_turn_id" uuid,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "threads_no_self_parent" CHECK ("threads"."id" != "threads"."parent_thread_id"),
	CONSTRAINT "threads_spawn_depth_nonneg" CHECK ("threads"."spawn_depth" >= 0),
	CONSTRAINT "threads_kind_valid" CHECK ("threads"."kind" IN ('primary', 'subagent')),
	CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('active', 'archived')),
	CONSTRAINT "threads_origin_type_valid" CHECK ("threads"."origin_type" IS NULL OR "threads"."origin_type" IN ('spawn', 'handoff', 'fork')),
	CONSTRAINT "threads_spawn_origin_subagent" CHECK ("threads"."origin_type" != 'spawn' OR "threads"."kind" = 'subagent'),
	CONSTRAINT "threads_handoff_fork_primary" CHECK ("threads"."origin_type" NOT IN ('handoff', 'fork') OR "threads"."kind" = 'primary'),
	CONSTRAINT "threads_handoff_summary_origin" CHECK ("threads"."handoff_summary" IS NULL OR "threads"."origin_type" = 'handoff'),
	CONSTRAINT "threads_spawn_status_subagent" CHECK ("threads"."spawn_status" IS NULL OR "threads"."kind" = 'subagent'),
	CONSTRAINT "threads_spawn_status_valid" CHECK ("threads"."spawn_status" IS NULL OR "threads"."spawn_status" IN ('running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "turn_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"model_response_id" uuid,
	"block_type" text NOT NULL,
	"sequence" integer NOT NULL,
	"text_content" text,
	"content" jsonb,
	"compact" text,
	"pruned" boolean DEFAULT false NOT NULL,
	"execution_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_turn_id" uuid,
	"agent_definition_id" uuid,
	"compaction_model" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"finish_reason" text,
	"error" text,
	"request_params" jsonb,
	"total_input_tokens" integer,
	"total_output_tokens" integer,
	"total_cost_usd" numeric(12, 6),
	"total_millicredits" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "turns_no_self_parent" CHECK ("turns"."parent_turn_id" IS NULL OR "turns"."parent_turn_id" != "turns"."id"),
	CONSTRAINT "turns_role_valid" CHECK ("turns"."role" IN ('user', 'assistant', 'system', 'compaction')),
	CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'complete', 'cancelled', 'error')),
	CONSTRAINT "turns_compaction_model_required" CHECK ("turns"."role" != 'compaction' OR "turns"."compaction_model" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "agent_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'primary' NOT NULL,
	"source_type" text DEFAULT 'builtin' NOT NULL,
	"base_definition_id" uuid,
	"source_package_id" text,
	"source_version" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_definition_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"loading_mode" text DEFAULT 'available' NOT NULL,
	"model_invocable" boolean,
	"user_invocable" boolean,
	CONSTRAINT "agent_skills_agent_definition_id_skill_id_pk" PRIMARY KEY("agent_definition_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent_subagents" (
	"parent_agent_id" uuid NOT NULL,
	"child_agent_id" uuid NOT NULL,
	CONSTRAINT "agent_subagents_parent_agent_id_child_agent_id_pk" PRIMARY KEY("parent_agent_id","child_agent_id"),
	CONSTRAINT "agent_subagents_no_self" CHECK ("agent_subagents"."parent_agent_id" != "agent_subagents"."child_agent_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'reference' NOT NULL,
	"model_invocable" boolean DEFAULT true NOT NULL,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"is_global" boolean DEFAULT false NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_type" text DEFAULT 'builtin' NOT NULL,
	"base_skill_id" uuid,
	"source_package_id" text,
	"source_package_version" text,
	"is_modified" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_installed_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'reference' NOT NULL,
	"model_invocable" boolean DEFAULT true NOT NULL,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_type" text DEFAULT 'user' NOT NULL,
	"source_package_id" text,
	"source_package_version" text,
	"base_skill_id" uuid,
	"is_modified" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_document_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"onboarding_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_project_favorites" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_project_favorites_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "document_restore_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"name" text NOT NULL,
	"checkpoint_id" bigint,
	"up_to_seq" bigint,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"up_to_seq" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_heads" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"fragment_name" text DEFAULT 'prosemirror' NOT NULL,
	"latest_update_seq" bigint DEFAULT 0 NOT NULL,
	"latest_state_vector" "bytea",
	"latest_checkpoint_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"update_data" "bytea" NOT NULL,
	"origin_type" text,
	"actor_user_id" uuid,
	"actor_agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_current_agent_id_agent_definitions_id_fk" FOREIGN KEY ("current_agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_model_response_id_model_responses_id_fk" FOREIGN KEY ("model_response_id") REFERENCES "public"."model_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_parent_agent_id_agent_definitions_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_child_agent_id_agent_definitions_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installed_skills" ADD CONSTRAINT "user_installed_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_checkpoint_id_document_yjs_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD CONSTRAINT "document_yjs_checkpoints_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_stripe_session" ON "credit_lots" USING btree ("stripe_session_id") WHERE "credit_lots"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_signup_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."grant_reason" = 'signup';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_monthly_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."grant_reason" LIKE 'monthly_%';--> statement-breakpoint
CREATE INDEX "credit_lots_fifo_spend" ON "credit_lots" USING btree ("user_id","expires_at","created_at","id") WHERE "credit_lots"."remaining_millicredits" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_debt_user" ON "credit_lots" USING btree ("user_id") WHERE "credit_lots"."source_type" = 'debt';--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_transactions_consumption_group" ON "credit_transactions" USING btree ("consumption_group_id") WHERE "credit_transactions"."consumption_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscriptions_active_user" ON "user_subscriptions" USING btree ("user_id") WHERE "user_subscriptions"."status" IN ('active', 'past_due', 'trialing');--> statement-breakpoint
CREATE INDEX "user_subscriptions_stripe_customer" ON "user_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."thread_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_thread_slug" ON "context_sources" USING btree ("thread_id","slug") WHERE "context_sources"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "context_sources_project_sort" ON "context_sources" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "documents_context_folder_active" ON "documents" USING btree ("context_source_id","folder_id") WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_active" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_active" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "documents_markdown_projection_fts" ON "documents" USING gin (to_tsvector('simple', "markdown_projection"));--> statement-breakpoint
CREATE INDEX "documents_markdown_projection_trgm" ON "documents" USING gin ("markdown_projection" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_name_fts" ON "documents" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE INDEX "documents_name_trgm" ON "documents" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "folders_context_parent_active" ON "folders" USING btree ("context_source_id","parent_id") WHERE "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_parent_name_active" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_root_name_active" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_slug_active" ON "projects" USING btree ("user_id","slug") WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_user_last_activity_active" ON "projects" USING btree ("user_id","last_activity_at" DESC NULLS LAST) WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "event_journal_thread_id" ON "event_journal" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_responses_turn_sequence" ON "model_responses" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "model_responses_provider_model_created" ON "model_responses" USING btree ("provider","model","created_at");--> statement-breakpoint
CREATE INDEX "threads_project_updated_active" ON "threads" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_created_by_active" ON "threads" USING btree ("created_by_user_id") WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_parent_created_active" ON "threads" USING btree ("parent_thread_id","created_at" DESC NULLS LAST) WHERE "threads"."parent_thread_id" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_blocks_turn_sequence" ON "turn_blocks" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "turn_blocks_turn_type" ON "turn_blocks" USING btree ("turn_id","block_type");--> statement-breakpoint
CREATE INDEX "turns_thread_created" ON "turns" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turns_parent_created" ON "turns" USING btree ("parent_turn_id","created_at" DESC NULLS LAST) WHERE "turns"."parent_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_single_root" ON "turns" USING btree ("thread_id") WHERE "turns"."parent_turn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definitions_project_slug" ON "agent_definitions" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "agent_definitions_project_sort_enabled" ON "agent_definitions" USING btree ("project_id","sort_order") WHERE "agent_definitions"."enabled" = true;--> statement-breakpoint
CREATE INDEX "agent_definitions_project_mode_enabled" ON "agent_definitions" USING btree ("project_id","mode") WHERE "agent_definitions"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_project_slug" ON "skills" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "skills_project_type_sort_enabled" ON "skills" USING btree ("project_id","type","sort_order") WHERE "skills"."enabled" = true;--> statement-breakpoint
CREATE INDEX "skills_project_global_enabled" ON "skills" USING btree ("project_id") WHERE "skills"."is_global" = true AND "skills"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "user_installed_skills_user_slug" ON "user_installed_skills" USING btree ("user_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_document_touches_turn_document" ON "turn_document_touches" USING btree ("turn_id","document_id");--> statement-breakpoint
CREATE INDEX "turn_document_touches_document_touched" ON "turn_document_touches" USING btree ("document_id","touched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turn_document_touches_turn" ON "turn_document_touches" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_document_id_desc" ON "document_yjs_checkpoints" USING btree ("document_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_yjs_updates_document_id" ON "document_yjs_updates" USING btree ("document_id","id");--> statement-breakpoint
CREATE VIEW "public"."credit_balances" AS (select "user_id", COALESCE(SUM("remaining_millicredits"), 0) as "total_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'grant'), 0) as "grant_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'purchase'), 0) as "purchased_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'debt'), 0) as "debt_balance_millicredits" from "credit_lots" where "credit_lots"."expires_at" IS NULL OR "credit_lots"."expires_at" > NOW() OR "credit_lots"."source_type" = 'debt' group by "credit_lots"."user_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_parent_turn_same_thread()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_thread_id UUID;
BEGIN
  IF NEW.parent_turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT thread_id INTO v_parent_thread_id
  FROM turns
  WHERE id = NEW.parent_turn_id;

  IF v_parent_thread_id IS NOT NULL AND v_parent_thread_id != NEW.thread_id THEN
    RAISE EXCEPTION 'parent_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_parent_turn_links_same_thread()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM turns child
    JOIN turns parent ON parent.id = child.parent_turn_id
    WHERE child.thread_id != parent.thread_id
  ) THEN
    RAISE EXCEPTION 'parent_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_active_leaf_same_thread()
RETURNS TRIGGER AS $$
DECLARE
  v_leaf_thread_id UUID;
BEGIN
  IF NEW.active_leaf_turn_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT thread_id INTO v_leaf_thread_id
  FROM turns
  WHERE id = NEW.active_leaf_turn_id;

  IF v_leaf_thread_id IS NOT NULL AND v_leaf_thread_id != NEW.id THEN
    RAISE EXCEPTION 'active_leaf_turn_id must reference a turn in the same thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_active_leaf_is_leaf()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM threads th
    LEFT JOIN turns leaf ON leaf.id = th.active_leaf_turn_id
    WHERE th.active_leaf_turn_id IS NOT NULL
      AND (
        leaf.id IS NULL
        OR leaf.thread_id != th.id
        OR EXISTS (
          SELECT 1
          FROM turns child
          WHERE child.parent_turn_id = th.active_leaf_turn_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'active_leaf_turn_id must reference a leaf turn in the same thread';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_context_source_thread_scope()
RETURNS TRIGGER AS $$
DECLARE
  v_thread_project_id UUID;
  v_thread_kind TEXT;
BEGIN
  IF NEW.thread_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id, kind
  INTO v_thread_project_id, v_thread_kind
  FROM threads
  WHERE id = NEW.thread_id;

  IF v_thread_project_id IS NOT NULL AND v_thread_project_id != NEW.project_id THEN
    RAISE EXCEPTION 'session context source thread_id must reference a thread in the same project';
  END IF;

  IF v_thread_kind IS NOT NULL AND v_thread_kind != 'primary' THEN
    RAISE EXCEPTION 'session context source thread_id must reference a primary thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_thread_context_source_scope()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM context_sources cs
    WHERE cs.thread_id = NEW.id
      AND (cs.project_id != NEW.project_id OR NEW.kind != 'primary')
  ) THEN
    RAISE EXCEPTION 'referenced session context source requires same-project primary thread';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_purchase_lot_subscription()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type != 'purchase' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM user_subscriptions us
    WHERE us.user_id = NEW.user_id
      AND us.status IN ('active', 'trialing')
  ) THEN
    RAISE EXCEPTION 'purchase credit lots require an active subscription';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION consume_credit_lots_fifo(
  p_user_id UUID,
  p_amount BIGINT,
  p_consumption_group_id UUID,
  p_usage_event_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  remaining_balance BIGINT,
  went_negative BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_amount_left BIGINT;
  v_lot RECORD;
  v_debit BIGINT;
  v_went_negative BOOLEAN := false;
  v_balance BIGINT;
  v_debt_lot_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive bigint';
  END IF;

  IF p_usage_event_id IS NULL OR btrim(p_usage_event_id) = '' THEN
    RAISE EXCEPTION 'p_usage_event_id is required for idempotent consumption';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('credit_fifo'),
    hashtext(p_user_id::text)
  );

  IF EXISTS (
    SELECT 1
    FROM credit_transactions
    WHERE usage_event_id = p_usage_event_id
      AND transaction_type = 'consumption'
  ) THEN
    SELECT COALESCE(cb.total_balance_millicredits, 0)
    INTO v_balance
    FROM credit_balances cb
    WHERE cb.user_id = p_user_id;

    RETURN QUERY SELECT
      COALESCE(v_balance, 0),
      COALESCE(v_balance, 0) < 0;
    RETURN;
  END IF;

  v_amount_left := p_amount;

  FOR v_lot IN
    SELECT id, remaining_millicredits
    FROM credit_lots
    WHERE user_id = p_user_id
      AND remaining_millicredits > 0
      AND source_type != 'debt'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  LOOP
    v_debit := LEAST(v_lot.remaining_millicredits, v_amount_left);

    UPDATE credit_lots
    SET remaining_millicredits = remaining_millicredits - v_debit
    WHERE id = v_lot.id;

    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata
    ) VALUES (
      p_user_id,
      'consumption',
      -v_debit,
      v_lot.id,
      p_consumption_group_id,
      p_usage_event_id,
      p_metadata
    );

    v_amount_left := v_amount_left - v_debit;
    EXIT WHEN v_amount_left <= 0;
  END LOOP;

  IF v_amount_left > 0 THEN
    v_went_negative := true;

    SELECT id INTO v_debt_lot_id
    FROM credit_lots
    WHERE user_id = p_user_id
      AND source_type = 'debt'
    FOR UPDATE;

    IF v_debt_lot_id IS NULL THEN
      INSERT INTO credit_lots (
        user_id,
        source_type,
        original_amount_millicredits,
        remaining_millicredits,
        metadata
      ) VALUES (
        p_user_id,
        'debt',
        v_amount_left,
        -v_amount_left,
        jsonb_build_object('auto_created', true)
      )
      RETURNING id INTO v_debt_lot_id;
    ELSE
      UPDATE credit_lots
      SET
        original_amount_millicredits = original_amount_millicredits + v_amount_left,
        remaining_millicredits = remaining_millicredits - v_amount_left
      WHERE id = v_debt_lot_id;
    END IF;

    INSERT INTO credit_transactions (
      user_id,
      transaction_type,
      amount_millicredits,
      lot_id,
      consumption_group_id,
      usage_event_id,
      metadata
    ) VALUES (
      p_user_id,
      'consumption',
      -v_amount_left,
      v_debt_lot_id,
      p_consumption_group_id,
      p_usage_event_id,
      p_metadata
    );
  END IF;

  SELECT COALESCE(cb.total_balance_millicredits, 0)
  INTO v_balance
  FROM credit_balances cb
  WHERE cb.user_id = p_user_id;

  RETURN QUERY SELECT
    COALESCE(v_balance, 0),
    COALESCE(v_balance, 0) < 0;
END;
$$;
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_turn_id_turns_id_fk" FOREIGN KEY ("origin_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_active_leaf_turn_id_turns_id_fk" FOREIGN KEY ("active_leaf_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_parent_turn_id_turns_id_fk" FOREIGN KEY ("parent_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_base_definition_id_agent_definitions_id_fk" FOREIGN KEY ("base_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_base_skill_id_skills_id_fk" FOREIGN KEY ("base_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_installed_skills" ADD CONSTRAINT "user_installed_skills_base_skill_id_user_installed_skills_id_fk" FOREIGN KEY ("base_skill_id") REFERENCES "public"."user_installed_skills"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_latest_checkpoint_id_document_yjs_checkpoints_id_fk" FOREIGN KEY ("latest_checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON "projects" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER folders_updated_at BEFORE UPDATE ON "folders" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON "documents" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER context_sources_updated_at BEFORE UPDATE ON "context_sources" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER threads_updated_at BEFORE UPDATE ON "threads" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER agent_definitions_updated_at BEFORE UPDATE ON "agent_definitions" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER skills_updated_at BEFORE UPDATE ON "skills" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER user_installed_skills_updated_at BEFORE UPDATE ON "user_installed_skills" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER user_subscriptions_updated_at BEFORE UPDATE ON "user_subscriptions" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON "user_preferences" FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER turns_validate_parent_same_thread BEFORE INSERT OR UPDATE OF thread_id, parent_turn_id ON "turns" FOR EACH ROW EXECUTE FUNCTION validate_parent_turn_same_thread();
--> statement-breakpoint
CREATE TRIGGER threads_validate_active_leaf_same_thread BEFORE INSERT OR UPDATE OF active_leaf_turn_id ON "threads" FOR EACH ROW EXECUTE FUNCTION validate_active_leaf_same_thread();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turns_validate_parent_links_same_thread AFTER INSERT OR UPDATE OF thread_id, parent_turn_id ON "turns" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_parent_turn_links_same_thread();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER threads_validate_active_leaf_is_leaf AFTER INSERT OR UPDATE OF active_leaf_turn_id ON "threads" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_active_leaf_is_leaf();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER turns_validate_active_leaf_is_leaf AFTER INSERT OR UPDATE OF thread_id, parent_turn_id ON "turns" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_active_leaf_is_leaf();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER context_sources_validate_thread_scope AFTER INSERT OR UPDATE OF project_id, thread_id ON "context_sources" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_context_source_thread_scope();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER threads_validate_context_source_scope AFTER UPDATE OF project_id, kind ON "threads" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_thread_context_source_scope();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_lots_validate_purchase_subscription AFTER INSERT OR UPDATE ON "credit_lots" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_lot_subscription();
