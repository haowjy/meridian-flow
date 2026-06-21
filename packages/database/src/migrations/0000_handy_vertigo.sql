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
	CONSTRAINT "agent_skills_agent_definition_id_skill_id_pk" PRIMARY KEY("agent_definition_id","skill_id"),
	CONSTRAINT "agent_skills_loading_mode_valid" CHECK ("agent_skills"."loading_mode" IN ('preloaded', 'available'))
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_type_valid" CHECK ("skills"."type" IN ('principle', 'guardrail', 'reference')),
	CONSTRAINT "skills_source_type_valid" CHECK ("skills"."source_type" IN ('builtin', 'package', 'user'))
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
CREATE TABLE "event_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"seq" bigint NOT NULL,
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
	"provider_request_id" text,
	"price_source" text DEFAULT 'computed' NOT NULL,
	"pricing_snapshot" jsonb,
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
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_responses_price_source_valid" CHECK ("model_responses"."price_source" IN ('computed', 'provider_reported', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "thread_documents" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"relationship" text DEFAULT 'editing' NOT NULL,
	"first_touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_documents_thread_id_document_id_pk" PRIMARY KEY("thread_id","document_id"),
	CONSTRAINT "thread_documents_relationship_valid" CHECK ("thread_documents"."relationship" IN ('editing', 'reading', 'created'))
);
--> statement-breakpoint
CREATE TABLE "thread_user_state" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "thread_user_state_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "thread_works" (
	"thread_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_works_pk" PRIMARY KEY("thread_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_agent_id" text,
	"working_state" jsonb,
	"composed_system_prompt" text,
	"baked_skill_slugs" jsonb,
	"system_prompt_hash" text,
	"parent_thread_id" uuid,
	"origin_turn_id" uuid,
	"origin_type" text,
	"spawn_status" text,
	"spawn_result" jsonb,
	"spawn_depth" integer DEFAULT 0 NOT NULL,
	"active_leaf_turn_id" uuid,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"next_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "threads_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "threads_no_self_parent" CHECK ("threads"."id" != "threads"."parent_thread_id"),
	CONSTRAINT "threads_spawn_depth_nonneg" CHECK ("threads"."spawn_depth" >= 0),
	CONSTRAINT "threads_next_seq_nonneg" CHECK ("threads"."next_seq" >= 0),
	CONSTRAINT "threads_kind_valid" CHECK ("threads"."kind" IN ('primary', 'subagent')),
	CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('active', 'archived')),
	CONSTRAINT "threads_origin_type_valid" CHECK ("threads"."origin_type" IS NULL OR "threads"."origin_type" IN ('spawn', 'handoff', 'fork')),
	CONSTRAINT "threads_spawn_origin_subagent" CHECK ("threads"."origin_type" != 'spawn' OR "threads"."kind" = 'subagent'),
	CONSTRAINT "threads_spawn_origin_required_fields" CHECK ("threads"."origin_type" != 'spawn' OR ("threads"."kind" = 'subagent' AND "threads"."parent_thread_id" IS NOT NULL AND "threads"."origin_turn_id" IS NOT NULL AND "threads"."spawn_status" IS NOT NULL)),
	CONSTRAINT "threads_handoff_fork_primary" CHECK ("threads"."origin_type" NOT IN ('handoff', 'fork') OR "threads"."kind" = 'primary'),
	CONSTRAINT "threads_fork_origin_required_fields" CHECK ("threads"."origin_type" != 'fork' OR ("threads"."kind" = 'primary' AND "threads"."parent_thread_id" IS NOT NULL AND "threads"."origin_turn_id" IS NOT NULL)),
	CONSTRAINT "threads_handoff_origin_required_fields" CHECK ("threads"."origin_type" != 'handoff' OR ("threads"."kind" = 'primary' AND "threads"."parent_thread_id" IS NOT NULL)),
	CONSTRAINT "threads_organic_origin_fields_empty" CHECK ("threads"."origin_type" IS NOT NULL OR ("threads"."parent_thread_id" IS NULL AND "threads"."origin_turn_id" IS NULL AND "threads"."spawn_status" IS NULL)),
	CONSTRAINT "threads_spawn_status_subagent" CHECK ("threads"."spawn_status" IS NULL OR "threads"."kind" = 'subagent'),
	CONSTRAINT "threads_spawn_status_valid" CHECK ("threads"."spawn_status" IS NULL OR "threads"."spawn_status" IN ('running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "turn_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"model_response_id" uuid,
	"block_type" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"sequence" integer NOT NULL,
	"model_text" text,
	"content" jsonb,
	"compact" text,
	"pruned" boolean DEFAULT false NOT NULL,
	"execution_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_blocks_status_valid" CHECK ("turn_blocks"."status" IN ('complete', 'partial')),
	CONSTRAINT "turn_blocks_block_type_valid" CHECK ("turn_blocks"."block_type" IN ('text', 'image', 'file', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'custom'))
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
	"total_input_tokens" integer,
	"total_output_tokens" integer,
	"total_cost_usd" numeric(12, 6),
	"total_millicredits" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "turns_no_self_parent" CHECK ("turns"."parent_turn_id" IS NULL OR "turns"."parent_turn_id" != "turns"."id"),
	CONSTRAINT "turns_role_valid" CHECK ("turns"."role" IN ('user', 'assistant', 'system', 'compaction')),
	CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'waiting_checkpoint', 'complete', 'cancelled', 'error')),
	CONSTRAINT "turns_compaction_model_required" CHECK ("turns"."role" != 'compaction' OR "turns"."compaction_model" IS NOT NULL)
);
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
	CONSTRAINT "credit_lots_grant_reason" CHECK ("credit_lots"."source_type" IN ('grant', 'subscription') OR "credit_lots"."grant_reason" IS NULL)
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
	CONSTRAINT "credit_transactions_transaction_type_valid" CHECK ("credit_transactions"."transaction_type" IN ('purchase', 'grant', 'consumption', 'expiration', 'refund')),
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
	CONSTRAINT "user_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "user_subscriptions_plan_valid" CHECK ("user_subscriptions"."plan" IN ('pro')),
	CONSTRAINT "user_subscriptions_status_valid" CHECK ("user_subscriptions"."status" IN ('active', 'past_due', 'cancelled', 'trialing'))
);
--> statement-breakpoint
CREATE TABLE "context_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"work_id" uuid,
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
	CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL) OR ("context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL)),
	CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work')),
	CONSTRAINT "context_sources_scope_work_fk" CHECK ("context_sources"."scope" = 'project' OR "context_sources"."work_id" IS NOT NULL),
	CONSTRAINT "context_sources_scope_project_fk" CHECK ("context_sources"."scope" = 'work' OR "context_sources"."work_id" IS NULL),
	CONSTRAINT "context_sources_adapter_type_valid" CHECK ("context_sources"."adapter_type" IN ('local', 'google_drive', 'dropbox', 'notion'))
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
	CONSTRAINT "documents_size_bytes_nonneg" CHECK ("documents"."size_bytes" IS NULL OR "documents"."size_bytes" >= 0),
	CONSTRAINT "documents_file_type_valid" CHECK ("documents"."file_type" IN ('markdown', 'python', 'typescript', 'javascript', 'json', 'shell', 'yaml', 'text', 'csv', 'notebook', 'pdf', 'png', 'jpg', 'svg', 'docx', 'image', 'binary'))
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
	"is_personal" boolean DEFAULT false NOT NULL,
	"system_prompt" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"persistence" text DEFAULT 'persisted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "works_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "works_visibility_valid" CHECK ("works"."visibility" IN ('private', 'shared')),
	CONSTRAINT "works_persistence_valid" CHECK ("works"."persistence" IN ('persisted', 'ephemeral'))
);
--> statement-breakpoint
CREATE TABLE "project_user_preferences" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_group_by" text DEFAULT 'work' NOT NULL,
	"pinned_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_agent_slug" text,
	"auto_resume_enabled" boolean DEFAULT true NOT NULL,
	"auto_resume_timeout_ms" integer DEFAULT 270000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_user_preferences_pk" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "project_user_preferences_thread_group_by_check" CHECK ("project_user_preferences"."thread_group_by" IN ('work', 'date', 'flat')),
	CONSTRAINT "project_user_preferences_auto_resume_timeout_check" CHECK ("project_user_preferences"."auto_resume_timeout_ms" > 0)
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
CREATE TABLE "project_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"results_uri" text NOT NULL,
	"storage_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"root_thread_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"tool_call_id" text,
	"agent_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_results_size_bytes_nonneg" CHECK ("project_results"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"last_active_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "waitlist_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_emails_email_unique" UNIQUE("email")
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
	"schema_version" integer DEFAULT 3 NOT NULL,
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
	"actor_turn_id" uuid,
	"actor_agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_parent_agent_id_agent_definitions_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_child_agent_id_agent_definitions_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installed_skills" ADD CONSTRAINT "user_installed_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_thread_same_project_fk" FOREIGN KEY ("project_id","thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_work_same_project_fk" FOREIGN KEY ("project_id","work_id") REFERENCES "public"."works"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_model_response_id_model_responses_id_fk" FOREIGN KEY ("model_response_id") REFERENCES "public"."model_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_root_thread_id_threads_id_fk" FOREIGN KEY ("root_thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_checkpoint_id_document_yjs_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_restore_points" ADD CONSTRAINT "document_restore_points_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD CONSTRAINT "document_yjs_checkpoints_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_turn_id_turns_id_fk" FOREIGN KEY ("actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definitions_project_slug" ON "agent_definitions" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "agent_definitions_project_sort_enabled" ON "agent_definitions" USING btree ("project_id","sort_order") WHERE "agent_definitions"."enabled" = true;--> statement-breakpoint
CREATE INDEX "agent_definitions_project_mode_enabled" ON "agent_definitions" USING btree ("project_id","mode") WHERE "agent_definitions"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_project_slug" ON "skills" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "skills_project_type_sort_enabled" ON "skills" USING btree ("project_id","type","sort_order") WHERE "skills"."enabled" = true;--> statement-breakpoint
CREATE INDEX "skills_project_global_enabled" ON "skills" USING btree ("project_id") WHERE "skills"."is_global" = true AND "skills"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "user_installed_skills_user_slug" ON "user_installed_skills" USING btree ("user_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "event_journal_thread_seq_unique" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "event_journal_thread_seq" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "event_journal_turn_id" ON "event_journal" USING btree ("turn_id","created_at") WHERE "event_journal"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_responses_turn_sequence" ON "model_responses" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "model_responses_provider_model_created" ON "model_responses" USING btree ("provider","model","created_at");--> statement-breakpoint
CREATE INDEX "thread_works_thread_idx" ON "thread_works" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_works_work_idx" ON "thread_works" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_works_primary_unique" ON "thread_works" USING btree ("thread_id") WHERE "thread_works"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "threads_project_updated_active" ON "threads" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_created_by_active" ON "threads" USING btree ("created_by_user_id") WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_parent_created_active" ON "threads" USING btree ("parent_thread_id","created_at" DESC NULLS LAST) WHERE "threads"."parent_thread_id" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_blocks_turn_sequence" ON "turn_blocks" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "turn_blocks_turn_type" ON "turn_blocks" USING btree ("turn_id","block_type");--> statement-breakpoint
CREATE INDEX "turns_thread_created" ON "turns" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turns_parent_created" ON "turns" USING btree ("parent_turn_id","created_at" DESC NULLS LAST) WHERE "turns"."parent_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_single_root" ON "turns" USING btree ("thread_id") WHERE "turns"."parent_turn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_stripe_session" ON "credit_lots" USING btree ("stripe_session_id") WHERE "credit_lots"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_signup_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."grant_reason" = 'signup';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_monthly_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."grant_reason" LIKE 'monthly_%';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_subscription_reason" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'subscription' AND "credit_lots"."grant_reason" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_lots_fifo_spend" ON "credit_lots" USING btree ("user_id","expires_at","created_at","id") WHERE "credit_lots"."remaining_millicredits" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_debt_user" ON "credit_lots" USING btree ("user_id") WHERE "credit_lots"."source_type" = 'debt';--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_transactions_consumption_group" ON "credit_transactions" USING btree ("consumption_group_id") WHERE "credit_transactions"."consumption_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscriptions_active_user" ON "user_subscriptions" USING btree ("user_id") WHERE "user_subscriptions"."status" IN ('active', 'past_due', 'trialing');--> statement-breakpoint
CREATE INDEX "user_subscriptions_stripe_customer" ON "user_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."work_id" IS NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_work_slug" ON "context_sources" USING btree ("work_id","slug") WHERE "context_sources"."work_id" IS NOT NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "context_sources_project_sort" ON "context_sources" USING btree ("project_id","sort_order") WHERE "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
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
CREATE UNIQUE INDEX "projects_user_personal" ON "projects" USING btree ("user_id") WHERE "projects"."is_personal" = true AND "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "works_project_updated_active" ON "works" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "works_created_by_active" ON "works" USING btree ("created_by_user_id") WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_document_touches_turn_document" ON "turn_document_touches" USING btree ("turn_id","document_id");--> statement-breakpoint
CREATE INDEX "turn_document_touches_document_touched" ON "turn_document_touches" USING btree ("document_id","touched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turn_document_touches_turn" ON "turn_document_touches" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "project_results_project_created_idx" ON "project_results" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_root_thread_idx" ON "project_results" USING btree ("root_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_last_active_project_idx" ON "users" USING btree ("last_active_project_id");--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_document_id_desc" ON "document_yjs_checkpoints" USING btree ("document_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_yjs_updates_document_id" ON "document_yjs_updates" USING btree ("document_id","id");--> statement-breakpoint
CREATE VIEW "public"."credit_balances" AS (select "user_id", COALESCE(SUM("remaining_millicredits"), 0) as "total_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'grant'), 0) as "grant_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'purchase'), 0) as "purchased_balance_millicredits", COALESCE(SUM("remaining_millicredits") FILTER (WHERE "source_type" = 'debt'), 0) as "debt_balance_millicredits" from "credit_lots" where "credit_lots"."expires_at" IS NULL OR "credit_lots"."expires_at" > NOW() OR "credit_lots"."source_type" = 'debt' group by "credit_lots"."user_id");