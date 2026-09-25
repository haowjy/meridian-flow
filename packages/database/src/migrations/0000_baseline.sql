-- Fresh-install baseline. No users/projects are seeded: project bootstrap creates
-- locked No Work and thread admission binds it. Historical data backfills are
-- vacuous on an empty database; legacy imports run separately from migrations.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE SEQUENCE "public"."context_availability_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "account_skill_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"logical_key" text NOT NULL,
	"selected_revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_sort_key" text NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_catalog_revisions" (
	"catalog_entry_id" uuid NOT NULL,
	"definition_revision_id" uuid NOT NULL,
	CONSTRAINT "agent_catalog_revisions_catalog_entry_id_definition_revision_id_pk" PRIMARY KEY("catalog_entry_id","definition_revision_id")
);
--> statement-breakpoint
CREATE TABLE "agent_definition_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_package_dependencies" (
	"package_revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dependency_revision_id" uuid NOT NULL,
	CONSTRAINT "agent_package_dependencies_package_revision_id_name_pk" PRIMARY KEY("package_revision_id","name")
);
--> statement-breakpoint
CREATE TABLE "agent_package_installation_history" (
	"installation_id" uuid NOT NULL,
	"package_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_package_installation_history_installation_id_package_revision_id_pk" PRIMARY KEY("installation_id","package_revision_id")
);
--> statement-breakpoint
CREATE TABLE "agent_package_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"coordinate" text NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"upstream_revision_id" uuid NOT NULL,
	"origin" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_package_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coordinate" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content_digest" text NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_agent_removals" (
	"project_id" uuid NOT NULL,
	"catalog_entry_id" uuid NOT NULL,
	CONSTRAINT "project_agent_removals_project_id_catalog_entry_id_pk" PRIMARY KEY("project_id","catalog_entry_id")
);
--> statement-breakpoint
CREATE TABLE "thread_agent_bindings" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"definition_revision_id" uuid,
	"configuration" jsonb NOT NULL,
	"invocation_overlay" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"reasoning_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"usage_breakdown" jsonb DEFAULT '{}'::jsonb,
	"cost_usd" numeric(12, 6),
	"millicredits" bigint,
	"stop_reason" text,
	"request_params" jsonb,
	"response_metadata" jsonb,
	"latency_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_responses_price_source_valid" CHECK ("model_responses"."price_source" IN ('computed', 'provider_reported', 'configured_rate', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "project_thread_counters" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"n" integer NOT NULL
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
CREATE TABLE "thread_execution_reports" (
	"assistant_turn_id" uuid PRIMARY KEY NOT NULL,
	"terminal_assistant_turn_id" uuid,
	"child_thread_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"origin" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"caller_thread_id" uuid,
	"caller_turn_id" uuid,
	"tool_call_id" text,
	"card_block_id" uuid,
	"agent_slug" text,
	"description" text,
	"capture" jsonb,
	"capture_tool_call_id" text,
	"outcome" text,
	"reason" text,
	"source" text,
	"summary" text,
	"payload" jsonb,
	"artifacts" jsonb,
	"cost_millicredits" bigint,
	"terminal_at" timestamp with time zone,
	"publication" text DEFAULT 'none' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_execution_reports_origin_valid" CHECK ("thread_execution_reports"."origin" IN ('spawn','foreground_message','thread_run')),
	CONSTRAINT "thread_execution_reports_delivery_valid" CHECK ("thread_execution_reports"."delivery_mode" IN ('background_notification','direct','none')),
	CONSTRAINT "thread_execution_reports_origin_delivery_valid" CHECK (("thread_execution_reports"."origin" = 'spawn' AND "thread_execution_reports"."delivery_mode" IN ('background_notification','direct')) OR ("thread_execution_reports"."origin" = 'foreground_message' AND "thread_execution_reports"."delivery_mode" = 'direct') OR ("thread_execution_reports"."origin" = 'thread_run' AND "thread_execution_reports"."delivery_mode" = 'none')),
	CONSTRAINT "thread_execution_reports_capture_call_coherent" CHECK (("thread_execution_reports"."capture" IS NULL AND "thread_execution_reports"."capture_tool_call_id" IS NULL) OR ("thread_execution_reports"."capture" IS NOT NULL AND "thread_execution_reports"."capture_tool_call_id" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_outcome_valid" CHECK ("thread_execution_reports"."outcome" IS NULL OR "thread_execution_reports"."outcome" IN ('succeeded','failed','cancelled')),
	CONSTRAINT "thread_execution_reports_source_valid" CHECK ("thread_execution_reports"."source" IS NULL OR "thread_execution_reports"."source" IN ('return_result','final_assistant','empty')),
	CONSTRAINT "thread_execution_reports_publication_valid" CHECK ("thread_execution_reports"."publication" IN ('none','pending','published','skipped')),
	CONSTRAINT "thread_execution_reports_terminal_coherent" CHECK (("thread_execution_reports"."outcome" IS NULL AND "thread_execution_reports"."terminal_at" IS NULL) OR ("thread_execution_reports"."outcome" IS NOT NULL AND "thread_execution_reports"."source" IS NOT NULL AND "thread_execution_reports"."summary" IS NOT NULL AND "thread_execution_reports"."terminal_at" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_publication_timestamp_coherent" CHECK (("thread_execution_reports"."publication" IN ('none','pending') AND "thread_execution_reports"."published_at" IS NULL) OR ("thread_execution_reports"."publication" IN ('published','skipped') AND "thread_execution_reports"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "thread_inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"intent" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "thread_inbox_messages_idem_unique" UNIQUE("thread_id","idempotency_key"),
	CONSTRAINT "thread_inbox_messages_intent_valid" CHECK ("thread_inbox_messages"."intent" IN ('message','notice')),
	CONSTRAINT "thread_inbox_messages_provenance_valid" CHECK (("thread_inbox_messages"."provenance"->>'kind' IN ('writer','agent','child','system')) IS TRUE),
	CONSTRAINT "thread_inbox_messages_body_valid" CHECK (("thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "thread_run_leases" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"adopted_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"turn_id" uuid,
	"holder_id" text NOT NULL,
	"phase" text DEFAULT 'generating' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_run_leases_phase_valid" CHECK ("thread_run_leases"."phase" IN ('generating','waiting'))
);
--> statement-breakpoint
CREATE TABLE "thread_user_state" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
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
	"ref" text,
	"kind" text DEFAULT 'primary' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"working_state" jsonb,
	"composed_system_prompt" text,
	"baked_skill_slugs" jsonb,
	"system_prompt_hash" text,
	"parent_thread_id" uuid,
	"root_thread_id" uuid,
	"origin_turn_id" uuid,
	"origin_type" text,
	"spawn_status" text,
	"spawn_depth" integer DEFAULT 0 NOT NULL,
	"active_leaf_turn_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"conversational_leaf_turn_id" uuid,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"next_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "threads_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "threads_spawn_root_required" CHECK ("threads"."kind" != 'subagent' OR "threads"."root_thread_id" IS NOT NULL),
	CONSTRAINT "threads_no_self_parent" CHECK ("threads"."id" != "threads"."parent_thread_id"),
	CONSTRAINT "threads_spawn_depth_nonneg" CHECK ("threads"."spawn_depth" >= 0),
	CONSTRAINT "threads_next_seq_nonneg" CHECK ("threads"."next_seq" >= 0),
	CONSTRAINT "threads_kind_valid" CHECK ("threads"."kind" IN ('primary', 'subagent')),
	CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('idle', 'archived')),
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
	"provider" text,
	"provider_data" jsonb,
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
	"compaction_model" text,
	"role" text NOT NULL,
	"ai_write_mode" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"finish_reason" text,
	"error" text,
	"model" text,
	"provider" text,
	"total_input_tokens" integer DEFAULT 0,
	"total_output_tokens" integer DEFAULT 0,
	"reasoning_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"total_cost_usd" numeric(12, 6) DEFAULT '0',
	"total_millicredits" bigint,
	"response_count" integer DEFAULT 0 NOT NULL,
	"request_params" jsonb,
	"response_metadata" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "turns_thread_id_id_unique" UNIQUE("thread_id","id"),
	CONSTRAINT "turns_no_self_parent" CHECK ("turns"."parent_turn_id" IS NULL OR "turns"."parent_turn_id" != "turns"."id"),
	CONSTRAINT "turns_role_valid" CHECK ("turns"."role" IN ('user', 'assistant', 'system', 'compaction')),
	CONSTRAINT "turns_ai_write_mode_valid" CHECK ("turns"."ai_write_mode" IS NULL OR "turns"."ai_write_mode" IN ('direct', 'draft')),
	CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'waiting_interrupt', 'complete', 'cancelled', 'error')),
	CONSTRAINT "turns_compaction_model_required" CHECK ("turns"."role" != 'compaction' OR "turns"."compaction_model" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "user_turn_admissions" (
	"thread_id" uuid NOT NULL,
	"submission_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"fingerprint" text,
	"state" text NOT NULL,
	"rejection_code" text,
	"user_turn_id" uuid,
	"assistant_turn_id" uuid,
	"resume_after_seq" text,
	"snapshot_floor_next_seq" text,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_turn_admissions_thread_id_submission_id_pk" PRIMARY KEY("thread_id","submission_id"),
	CONSTRAINT "user_turn_admissions_state_valid" CHECK ("user_turn_admissions"."state" IN ('pending', 'accepted', 'rejected', 'retired'))
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
CREATE TABLE "document_previous_locations" (
	"context_source_id" uuid NOT NULL,
	"path" text NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'content' NOT NULL,
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
	"provisional_name" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_size_bytes_nonneg" CHECK ("documents"."size_bytes" IS NULL OR "documents"."size_bytes" >= 0),
	CONSTRAINT "documents_file_type_valid" CHECK ("documents"."file_type" IN ('markdown', 'python', 'typescript', 'javascript', 'json', 'shell', 'yaml', 'text', 'csv', 'notebook', 'pdf', 'png', 'jpg', 'svg', 'docx', 'image', 'binary')),
	CONSTRAINT "documents_kind_valid" CHECK ("documents"."kind" IN ('content', 'manifest'))
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
	"default_bootstrap_ready" boolean DEFAULT false NOT NULL,
	"system_prompt" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "upload_intakes" (
	"project_id" uuid NOT NULL,
	"intake_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"work_id" uuid,
	"context_source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"byte_digest" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"final_path" text NOT NULL,
	"object_key" text NOT NULL,
	"file_type" text NOT NULL,
	"canonical_uri" text NOT NULL,
	"location_revision" uuid NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"storage_url" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intakes_project_intake_unique" UNIQUE("project_id","intake_id"),
	CONSTRAINT "upload_intakes_document_unique" UNIQUE("document_id"),
	CONSTRAINT "upload_intakes_state_valid" CHECK ("upload_intakes"."state" IN ('reserved', 'object_stored', 'finalized', 'deleted')),
	CONSTRAINT "upload_intakes_digest_valid" CHECK ("upload_intakes"."byte_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"is_no_work" boolean DEFAULT false NOT NULL,
	"goal" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"ai_write_mode" text DEFAULT 'direct' NOT NULL,
	"entity_revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "works_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "works_name_nonempty" CHECK (btrim("works"."name") <> ''),
	CONSTRAINT "works_no_work_slug" CHECK (("works"."is_no_work" AND "works"."slug" IS NULL) OR (NOT "works"."is_no_work" AND "works"."slug" IS NOT NULL)),
	CONSTRAINT "works_no_work_active" CHECK (NOT "works"."is_no_work" OR "works"."status" = 'active'),
	CONSTRAINT "works_slug_valid" CHECK ("works"."slug" IS NULL OR "works"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "works_status_valid" CHECK ("works"."status" IN ('active', 'archived')),
	CONSTRAINT "works_ai_write_mode_valid" CHECK ("works"."ai_write_mode" IN ('direct', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "context_availability_heads" (
	"authority_key" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_catalog_commits" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"first_revision" bigint NOT NULL,
	"last_revision" bigint NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_catalog_entries" (
	"scope_key" text NOT NULL,
	"entry_id" text NOT NULL,
	"entry" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_catalog_entries_scope_key_entry_id_pk" PRIMARY KEY("scope_key","entry_id")
);
--> statement-breakpoint
CREATE TABLE "context_catalog_scope_heads" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"head_revision" bigint DEFAULT 0 NOT NULL,
	"oldest_revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_operation_receipts" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_operation_receipts_user_id_project_id_operation_id_pk" PRIMARY KEY("user_id","project_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "project_user_preferences" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_group_by" text DEFAULT 'work' NOT NULL,
	"pinned_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
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
CREATE TABLE "user_recent_documents" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_recent_documents_pk" PRIMARY KEY("user_id","document_id")
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
	"stripe_customer_id" text,
	"working_set_sync_enabled" boolean DEFAULT true NOT NULL,
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
CREATE TABLE "project_user_working_sets" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recent_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_user_working_sets_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "agent_edit_mutations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"w_id" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"authoring_response_id" uuid,
	"actor_kind" text DEFAULT 'agent' NOT NULL,
	"user_id" text,
	"write_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_seq" bigint NOT NULL,
	"undo_update_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	CONSTRAINT "agent_edit_mutations_status_valid" CHECK ("agent_edit_mutations"."status" IN ('active', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "agent_edit_wid_counters" (
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"next_wid" integer NOT NULL,
	CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_pk" PRIMARY KEY("document_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "branch_push_outbox_updates" (
	"push_id" bigint NOT NULL,
	"ordinal" bigint NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	CONSTRAINT "branch_push_outbox_updates_push_id_source_kind_source_id_pk" PRIMARY KEY("push_id","source_kind","source_id"),
	CONSTRAINT "branch_push_outbox_updates_ordinal_valid" CHECK ("branch_push_outbox_updates"."ordinal" >= 0),
	CONSTRAINT "branch_push_outbox_updates_source_kind_valid" CHECK ("branch_push_outbox_updates"."source_kind" IN ('journal', 'staged_push', 'initial_reconcile'))
);
--> statement-breakpoint
CREATE TABLE "branch_push_settlement_outbox" (
	"push_id" bigint PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"document_title" text NOT NULL,
	"lock_cut_update" "bytea" NOT NULL,
	"push_update" "bytea" NOT NULL,
	"trail_seed" jsonb NOT NULL,
	"join_version" bigint DEFAULT 0 NOT NULL,
	"classified_join_version" bigint DEFAULT 0 NOT NULL,
	"settled_join_version" bigint,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_push_settlement_outbox_state_valid" CHECK ("branch_push_settlement_outbox"."state" IN ('pending', 'blocked', 'completed')),
	CONSTRAINT "branch_push_settlement_outbox_terminal_shape" CHECK ((
        ("branch_push_settlement_outbox"."state" = 'completed' AND "branch_push_settlement_outbox"."completed_at" IS NOT NULL AND "branch_push_settlement_outbox"."blocked_at" IS NULL AND "branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_outbox"."state" = 'blocked' AND "branch_push_settlement_outbox"."blocked_at" IS NOT NULL AND "branch_push_settlement_outbox"."last_error_code" IS NOT NULL AND "branch_push_settlement_outbox"."completed_at" IS NULL AND "branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
        OR ("branch_push_settlement_outbox"."state" = 'pending' AND "branch_push_settlement_outbox"."blocked_at" IS NULL AND "branch_push_settlement_outbox"."completed_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_outbox_claim_shape" CHECK ("branch_push_settlement_outbox"."state" <> 'pending' OR (
        ("branch_push_settlement_outbox"."claim_token" IS NOT NULL AND "branch_push_settlement_outbox"."claim_kind" IS NOT NULL AND "branch_push_settlement_outbox"."claimed_at" IS NOT NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NOT NULL)
        OR ("branch_push_settlement_outbox"."claim_token" IS NULL AND "branch_push_settlement_outbox"."claim_kind" IS NULL AND "branch_push_settlement_outbox"."claimed_at" IS NULL AND "branch_push_settlement_outbox"."lease_expires_at" IS NULL)
      )),
	CONSTRAINT "branch_push_settlement_outbox_claim_kind_valid" CHECK ("branch_push_settlement_outbox"."claim_kind" IS NULL OR "branch_push_settlement_outbox"."claim_kind" IN ('warm', 'recovery')),
	CONSTRAINT "branch_push_settlement_outbox_counters_valid" CHECK ("branch_push_settlement_outbox"."attempt_count" >= 0 AND "branch_push_settlement_outbox"."join_version" >= 0 AND "branch_push_settlement_outbox"."claim_epoch" >= 0 AND "branch_push_settlement_outbox"."classified_join_version" <= "branch_push_settlement_outbox"."join_version" AND ("branch_push_settlement_outbox"."settled_join_version" IS NULL OR "branch_push_settlement_outbox"."settled_join_version" <= "branch_push_settlement_outbox"."join_version"))
);
--> statement-breakpoint
CREATE TABLE "branch_write_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"branch_id" text NOT NULL,
	"generation" integer NOT NULL,
	"w_id" integer,
	"source" text DEFAULT 'agent' NOT NULL,
	"thread_id" uuid,
	"turn_id" uuid,
	"actor_user_id" uuid,
	"update_data" "bytea" NOT NULL,
	"draft_base_update_seq" bigint NOT NULL,
	"update_meta" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"pushed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_write_journal_source_valid" CHECK ("branch_write_journal"."source" IN ('agent', 'writer')),
	CONSTRAINT "branch_write_journal_status_valid" CHECK ("branch_write_journal"."status" IN ('active', 'pushed', 'discarded', 'rollback_pending'))
);
--> statement-breakpoint
CREATE TABLE "change_trail_delivery_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"trail_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"event_kind" text NOT NULL,
	"change_count" integer NOT NULL,
	"document_count" integer NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"words_added" integer,
	"words_removed" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_delivery_outbox_event_kind_valid" CHECK ("change_trail_delivery_outbox"."event_kind" IN ('updated', 'settled')),
	CONSTRAINT "change_trail_delivery_outbox_counts_valid" CHECK ("change_trail_delivery_outbox"."change_count" >= 0 AND "change_trail_delivery_outbox"."document_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "change_trail_document_details" (
	"trail_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_title" text NOT NULL,
	"words_added" integer,
	"words_removed" integer,
	"changes" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_document_details_trail_id_document_id_pk" PRIMARY KEY("trail_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "change_trail_document_occurrences" (
	"trail_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"projection_revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "change_trail_document_occurrences_trail_id_document_id_pk" PRIMARY KEY("trail_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "change_trail_shells" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"owner_kind" text NOT NULL,
	"state" text DEFAULT 'building' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_count" integer NOT NULL,
	"document_count" integer NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"words_added" integer,
	"words_removed" integer,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_trail_shells_owner_kind_valid" CHECK ("change_trail_shells"."owner_kind" IN ('turn', 'shared')),
	CONSTRAINT "change_trail_shells_owner_shape" CHECK (("change_trail_shells"."owner_kind" = 'turn' AND "change_trail_shells"."turn_id" IS NOT NULL) OR ("change_trail_shells"."owner_kind" = 'shared' AND "change_trail_shells"."turn_id" IS NULL)),
	CONSTRAINT "change_trail_shells_state_counts_valid" CHECK ("change_trail_shells"."state" IN ('building', 'settling', 'settled') AND "change_trail_shells"."version" > 0 AND "change_trail_shells"."change_count" >= 0 AND "change_trail_shells"."document_count" >= 0 AND (("change_trail_shells"."state" = 'settled') = ("change_trail_shells"."settled_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "document_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"upstream_branch_id" text,
	"work_id" uuid,
	"thread_id" uuid,
	"push_policy" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"discarded_state_vector" "bytea",
	"schema_version" integer DEFAULT 5000 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_branches_kind_valid" CHECK ("document_branches"."kind" IN ('work_draft', 'thread_peer')),
	CONSTRAINT "document_branches_push_policy_valid" CHECK ("document_branches"."push_policy" IN ('manual', 'auto')),
	CONSTRAINT "document_branches_status_valid" CHECK ("document_branches"."status" IN ('active', 'closed')),
	CONSTRAINT "document_branches_owner_shape" CHECK (("document_branches"."kind" = 'work_draft' AND "document_branches"."work_id" IS NOT NULL AND "document_branches"."thread_id" IS NULL) OR ("document_branches"."kind" = 'thread_peer' AND "document_branches"."thread_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "document_yjs_checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"authority_generation" bigint NOT NULL,
	"attribution_manifest" jsonb NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"up_to_seq" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_heads" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"authority_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"authority_generation" bigint DEFAULT 1 NOT NULL,
	"next_admission_sequence" bigint DEFAULT 1 NOT NULL,
	"fragment_name" text DEFAULT 'prosemirror' NOT NULL,
	"schema_version" integer DEFAULT 5000 NOT NULL,
	"latest_update_seq" bigint DEFAULT 0 NOT NULL,
	"latest_state_vector" "bytea",
	"latest_checkpoint_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_yjs_reversal_ops" (
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"update_seq" bigint NOT NULL,
	"handle" text NOT NULL,
	"direction" text NOT NULL,
	CONSTRAINT "document_yjs_reversal_ops_document_id_thread_id_update_seq_handle_pk" PRIMARY KEY("document_id","thread_id","update_seq","handle"),
	CONSTRAINT "document_yjs_reversal_ops_direction_valid" CHECK ("document_yjs_reversal_ops"."direction" IN ('undo', 'redo'))
);
--> statement-breakpoint
CREATE TABLE "document_yjs_reversals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"authoring_response_id" uuid,
	"write_id" text NOT NULL,
	"status" text NOT NULL,
	"undo_update_seq" bigint NOT NULL,
	"redo_update_seq" bigint,
	"expires_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_yjs_reversals_status_valid" CHECK ("document_yjs_reversals"."status" IN ('active', 'reversed', 'redone', 'reconciled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "document_yjs_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"authority_generation" bigint NOT NULL,
	"admission_sequence" bigint NOT NULL,
	"batch_ordinal" integer DEFAULT 0 NOT NULL,
	"update_data" "bytea" NOT NULL,
	"origin_type" text,
	"actor_user_id" uuid,
	"actor_turn_id" uuid,
	"authoring_response_id" uuid,
	"reversal_actor_type" text,
	"reversal_actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_notices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"message" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_lineage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"branch_id" text,
	"branch_generation" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"journal_ids" bigint[] NOT NULL,
	"upstream_update_seq" bigint,
	"pushed_by_user_id" uuid,
	"thread_id" uuid,
	"turn_id" uuid,
	"idempotency_key" text NOT NULL,
	"receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_trail_work" (
	"journal_id" bigint PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"branch_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_trail_work_state_valid" CHECK ("turn_trail_work"."state" IN ('pending', 'running', 'complete', 'no_op', 'exhausted'))
);
--> statement-breakpoint
ALTER TABLE "account_skill_installs" ADD CONSTRAINT "account_skill_installs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_catalog_entries" ADD CONSTRAINT "agent_catalog_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_catalog_entries" ADD CONSTRAINT "agent_catalog_entries_selected_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("selected_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_catalog_revisions" ADD CONSTRAINT "agent_catalog_revisions_catalog_entry_id_agent_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."agent_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_catalog_revisions" ADD CONSTRAINT "agent_catalog_revisions_definition_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("definition_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_definition_revisions" ADD CONSTRAINT "agent_definition_revisions_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_dependencies" ADD CONSTRAINT "agent_package_dependencies_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_dependencies" ADD CONSTRAINT "agent_package_dependencies_dependency_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("dependency_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_installation_history" ADD CONSTRAINT "agent_package_installation_history_installation_id_agent_package_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."agent_package_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_installation_history" ADD CONSTRAINT "agent_package_installation_history_package_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("package_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_current_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_package_installations" ADD CONSTRAINT "agent_package_installations_upstream_revision_id_agent_package_revisions_id_fk" FOREIGN KEY ("upstream_revision_id") REFERENCES "public"."agent_package_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_removals" ADD CONSTRAINT "project_agent_removals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent_removals" ADD CONSTRAINT "project_agent_removals_catalog_entry_id_agent_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."agent_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD CONSTRAINT "thread_agent_bindings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_agent_bindings" ADD CONSTRAINT "thread_agent_bindings_definition_revision_id_agent_definition_revisions_id_fk" FOREIGN KEY ("definition_revision_id") REFERENCES "public"."agent_definition_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_journal" ADD CONSTRAINT "event_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_responses" ADD CONSTRAINT "model_responses_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_thread_counters" ADD CONSTRAINT "project_thread_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_assistant_turn_id_turns_id_fk" FOREIGN KEY ("assistant_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_terminal_assistant_turn_id_turns_id_fk" FOREIGN KEY ("terminal_assistant_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_thread_id_threads_id_fk" FOREIGN KEY ("child_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_thread_id_threads_id_fk" FOREIGN KEY ("caller_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_turn_id_turns_id_fk" FOREIGN KEY ("caller_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_card_block_id_turn_blocks_id_fk" FOREIGN KEY ("card_block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_turn_fk" FOREIGN KEY ("child_thread_id","assistant_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD CONSTRAINT "thread_run_leases_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_thread_same_project_fk" FOREIGN KEY ("project_id","thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_work_same_project_fk" FOREIGN KEY ("project_id","work_id") REFERENCES "public"."works"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_spawn_root_same_project_fk" FOREIGN KEY ("project_id","root_thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_model_response_id_model_responses_id_fk" FOREIGN KEY ("model_response_id") REFERENCES "public"."model_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_turn_admissions" ADD CONSTRAINT "user_turn_admissions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_catalog_commits" ADD CONSTRAINT "context_catalog_commits_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_catalog_entries" ADD CONSTRAINT "context_catalog_entries_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_document_touches" ADD CONSTRAINT "turn_document_touches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_root_thread_id_threads_id_fk" FOREIGN KEY ("root_thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_mutations" ADD CONSTRAINT "agent_edit_mutations_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_outbox_updates" ADD CONSTRAINT "branch_push_outbox_updates_push_id_branch_push_settlement_outbox_push_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."branch_push_settlement_outbox"("push_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_push_id_push_lineage_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."push_lineage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_push_settlement_outbox" ADD CONSTRAINT "branch_push_settlement_outbox_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_write_journal" ADD CONSTRAINT "branch_write_journal_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_delivery_outbox" ADD CONSTRAINT "change_trail_delivery_outbox_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD CONSTRAINT "change_trail_document_details_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD CONSTRAINT "change_trail_document_details_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_document_occurrences" ADD CONSTRAINT "change_trail_document_occurrences_trail_id_change_trail_shells_id_fk" FOREIGN KEY ("trail_id") REFERENCES "public"."change_trail_shells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD CONSTRAINT "change_trail_shells_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_upstream_branch_id_document_branches_id_fk" FOREIGN KEY ("upstream_branch_id") REFERENCES "public"."document_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD CONSTRAINT "document_yjs_checkpoints_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_latest_checkpoint_id_document_yjs_checkpoints_id_fk" FOREIGN KEY ("latest_checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversal_ops" ADD CONSTRAINT "document_yjs_reversal_ops_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_reversals" ADD CONSTRAINT "document_yjs_reversals_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_turn_id_turns_id_fk" FOREIGN KEY ("actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_authoring_response_id_model_responses_id_fk" FOREIGN KEY ("authoring_response_id") REFERENCES "public"."model_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_reversal_actor_user_id_users_id_fk" FOREIGN KEY ("reversal_actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notices" ADD CONSTRAINT "pending_notices_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_pushed_by_user_id_users_id_fk" FOREIGN KEY ("pushed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_lineage" ADD CONSTRAINT "push_lineage_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_journal_id_branch_write_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."branch_write_journal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_trail_work" ADD CONSTRAINT "turn_trail_work_branch_id_document_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."document_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_skill_installs_owner_slug" ON "account_skill_installs" USING btree ("owner_user_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_catalog_entries_personal_key" ON "agent_catalog_entries" USING btree ("owner_user_id","logical_key") WHERE "agent_catalog_entries"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_catalog_entries_system_key" ON "agent_catalog_entries" USING btree ("logical_key") WHERE "agent_catalog_entries"."owner_user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_catalog_entries_owner_name" ON "agent_catalog_entries" USING btree ("owner_user_id","name_sort_key","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_definition_revisions_package_slug" ON "agent_definition_revisions" USING btree ("package_revision_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_installations_personal_coordinate" ON "agent_package_installations" USING btree ("owner_user_id","coordinate") WHERE "agent_package_installations"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_installations_system_coordinate" ON "agent_package_installations" USING btree ("coordinate") WHERE "agent_package_installations"."owner_user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_package_revisions_coordinate_digest" ON "agent_package_revisions" USING btree ("coordinate","content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "event_journal_thread_seq_unique" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "event_journal_event_id_unique" ON "event_journal" USING btree (("payload"->>'eventId')) WHERE "event_journal"."payload"->>'eventId' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_journal_thread_seq" ON "event_journal" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "event_journal_turn_id" ON "event_journal" USING btree ("turn_id","created_at") WHERE "event_journal"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_responses_turn_sequence" ON "model_responses" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "model_responses_provider_model_created" ON "model_responses" USING btree ("provider","model","created_at");--> statement-breakpoint
CREATE INDEX "thread_execution_reports_pending" ON "thread_execution_reports" USING btree ("assistant_turn_id") WHERE "thread_execution_reports"."publication" = 'pending';--> statement-breakpoint
CREATE INDEX "thread_inbox_messages_pending" ON "thread_inbox_messages" USING btree ("thread_id","seq") WHERE "thread_inbox_messages"."delivered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "thread_run_leases_expiry" ON "thread_run_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "thread_works_thread_idx" ON "thread_works" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_works_work_idx" ON "thread_works" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_works_primary_unique" ON "thread_works" USING btree ("thread_id") WHERE "thread_works"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_project_ref" ON "threads" USING btree ("project_id","ref") WHERE "threads"."ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_project_updated_active" ON "threads" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_project_activity_primary_active" ON "threads" USING btree ("project_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "threads"."kind" = 'primary' AND "threads"."deleted_at" IS NULL AND "threads"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "threads_created_by_active" ON "threads" USING btree ("created_by_user_id") WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_parent_created_active" ON "threads" USING btree ("parent_thread_id","created_at" DESC NULLS LAST) WHERE "threads"."parent_thread_id" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_blocks_turn_sequence" ON "turn_blocks" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "turn_blocks_turn_type" ON "turn_blocks" USING btree ("turn_id","block_type");--> statement-breakpoint
CREATE INDEX "turns_thread_created" ON "turns" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turns_parent_created" ON "turns" USING btree ("parent_turn_id","created_at" DESC NULLS LAST) WHERE "turns"."parent_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_single_root" ON "turns" USING btree ("thread_id") WHERE "turns"."parent_turn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_stripe_session" ON "credit_lots" USING btree ("stripe_session_id") WHERE "credit_lots"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_free_tier_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'grant' AND "credit_lots"."grant_reason" LIKE 'free_tier_%';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_subscription_reason" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'subscription' AND "credit_lots"."grant_reason" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_lots_fifo_spend" ON "credit_lots" USING btree ("user_id","expires_at","created_at","id") WHERE "credit_lots"."remaining_millicredits" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_debt_user" ON "credit_lots" USING btree ("user_id") WHERE "credit_lots"."source_type" = 'debt';--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_transactions_consumption_group" ON "credit_transactions" USING btree ("consumption_group_id") WHERE "credit_transactions"."consumption_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."work_id" IS NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_work_slug" ON "context_sources" USING btree ("work_id","slug") WHERE "context_sources"."work_id" IS NOT NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "context_sources_project_sort" ON "context_sources" USING btree ("project_id","sort_order") WHERE "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_previous_locations_path" ON "document_previous_locations" USING hash ("path");--> statement-breakpoint
CREATE INDEX "document_previous_locations_source" ON "document_previous_locations" USING btree ("context_source_id");--> statement-breakpoint
CREATE INDEX "document_previous_locations_document" ON "document_previous_locations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_context_folder_active" ON "documents" USING btree ("context_source_id","folder_id") WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_active" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_active" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND "documents"."kind" = 'content';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_manifest_context_active" ON "documents" USING btree ("context_source_id") WHERE "documents"."deleted_at" IS NULL AND "documents"."kind" = 'manifest';--> statement-breakpoint
CREATE INDEX "documents_markdown_projection_fts" ON "documents" USING gin (to_tsvector('simple', "markdown_projection"));--> statement-breakpoint
CREATE INDEX "documents_markdown_projection_trgm" ON "documents" USING gin ("markdown_projection" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_name_fts" ON "documents" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE INDEX "documents_name_trgm" ON "documents" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "folders_context_parent_active" ON "folders" USING btree ("context_source_id","parent_id") WHERE "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_parent_name_active" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_root_name_active" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_slug" ON "projects" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "projects_user_last_activity_active" ON "projects" USING btree ("user_id","last_activity_at" DESC NULLS LAST) WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_personal" ON "projects" USING btree ("user_id") WHERE "projects"."is_personal" = true AND "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intakes_source_path_live" ON "upload_intakes" USING btree ("context_source_id",lower("final_path")) WHERE "upload_intakes"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "works_project_updated_active" ON "works" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "works_created_by_active" ON "works" USING btree ("created_by_user_id") WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_name_active" ON "works" USING btree ("project_id",lower("name")) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_slug" ON "works" USING btree ("project_id","slug") WHERE "works"."slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_no_work_active" ON "works" USING btree ("project_id") WHERE "works"."is_no_work" = true AND "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_catalog_commits_scope_revision_uq" ON "context_catalog_commits" USING btree ("scope_key","first_revision");--> statement-breakpoint
CREATE INDEX "context_catalog_commits_commit_idx" ON "context_catalog_commits" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "context_catalog_entries_parent_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'parentId'));--> statement-breakpoint
CREATE INDEX "context_catalog_entries_uri_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'uri'));--> statement-breakpoint
CREATE UNIQUE INDEX "turn_document_touches_turn_document" ON "turn_document_touches" USING btree ("turn_id","document_id");--> statement-breakpoint
CREATE INDEX "turn_document_touches_document_touched" ON "turn_document_touches" USING btree ("document_id","touched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "turn_document_touches_turn" ON "turn_document_touches" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "user_recent_documents_user_opened_idx" ON "user_recent_documents" USING btree ("user_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_project_created_idx" ON "project_results" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_root_thread_idx" ON "project_results" USING btree ("root_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_write_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","write_id") WHERE "agent_edit_mutations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_mutations_document_thread_w_id" ON "agent_edit_mutations" USING btree ("document_id","thread_id","w_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_thread_status" ON "agent_edit_mutations" USING btree ("document_id","thread_id","status");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_turn" ON "agent_edit_mutations" USING btree ("document_id","thread_id","turn_id");--> statement-breakpoint
CREATE INDEX "agent_edit_mutations_thread_turn" ON "agent_edit_mutations" USING btree ("thread_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_push_outbox_updates_ordinal" ON "branch_push_outbox_updates" USING btree ("push_id","ordinal");--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_recovery" ON "branch_push_settlement_outbox" USING btree ("available_at","lease_expires_at","created_at") WHERE "branch_push_settlement_outbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "branch_push_settlement_outbox_document_unresolved" ON "branch_push_settlement_outbox" USING btree ("document_id") WHERE "branch_push_settlement_outbox"."state" <> 'completed';--> statement-breakpoint
CREATE INDEX "branch_write_journal_branch" ON "branch_write_journal" USING btree ("branch_id","generation","id");--> statement-breakpoint
CREATE INDEX "branch_write_journal_thread_turn" ON "branch_write_journal" USING btree ("branch_id","thread_id","turn_id");--> statement-breakpoint
CREATE INDEX "branch_write_journal_active" ON "branch_write_journal" USING btree ("branch_id","generation","status") WHERE "branch_write_journal"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_delivery_outbox_version" ON "change_trail_delivery_outbox" USING btree ("trail_id","version","event_kind");--> statement-breakpoint
CREATE INDEX "change_trail_delivery_outbox_pending" ON "change_trail_delivery_outbox" USING btree ("created_at") WHERE "change_trail_delivery_outbox"."delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_shells_turn_owner" ON "change_trail_shells" USING btree ("thread_id","turn_id") WHERE "change_trail_shells"."owner_kind" = 'turn';--> statement-breakpoint
CREATE UNIQUE INDEX "change_trail_shells_shared_owner" ON "change_trail_shells" USING btree ("thread_id") WHERE "change_trail_shells"."owner_kind" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX "document_branches_active_work_draft" ON "document_branches" USING btree ("document_id","work_id") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_branches_active_work_draft_by_work" ON "document_branches" USING btree ("work_id","id","generation") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "document_branches_active_thread_peer" ON "document_branches" USING btree ("document_id","thread_id") WHERE "document_branches"."kind" = 'thread_peer' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_document_id_desc" ON "document_yjs_checkpoints" USING btree ("document_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_checkpoints_initial" ON "document_yjs_checkpoints" USING btree ("document_id") WHERE "document_yjs_checkpoints"."up_to_seq" = 0;--> statement-breakpoint
CREATE INDEX "document_yjs_reversal_ops_document_thread_handle" ON "document_yjs_reversal_ops" USING btree ("document_id","thread_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_reversals_document_thread_write" ON "document_yjs_reversals" USING btree ("document_id","thread_id","write_id");--> statement-breakpoint
CREATE INDEX "document_yjs_reversals_document_thread" ON "document_yjs_reversals" USING btree ("document_id","thread_id");--> statement-breakpoint
CREATE INDEX "document_yjs_updates_document_id" ON "document_yjs_updates" USING btree ("document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_updates_authority_admission" ON "document_yjs_updates" USING btree ("authority_id","authority_generation","admission_sequence","batch_ordinal");--> statement-breakpoint
CREATE INDEX "pending_notices_thread" ON "pending_notices" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_lineage_idempotency" ON "push_lineage" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "push_lineage_document" ON "push_lineage" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "push_lineage_branch" ON "push_lineage" USING btree ("branch_id","branch_generation");--> statement-breakpoint
CREATE INDEX "push_lineage_turn" ON "push_lineage" USING btree ("thread_id","turn_id");--> statement-breakpoint
CREATE INDEX "push_lineage_receipt" ON "push_lineage" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "turn_trail_work_ready" ON "turn_trail_work" USING btree ("next_attempt_at") WHERE "turn_trail_work"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "turn_trail_work_owner" ON "turn_trail_work" USING btree ("thread_id","turn_id","state");
--> statement-breakpoint
-- Change-trail lifecycle behavior is not represented by Drizzle snapshots.
CREATE FUNCTION enlist_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NOT NULL AND NEW.turn_id IS NOT NULL THEN
    INSERT INTO turn_trail_work (journal_id, thread_id, turn_id, branch_id, state)
    VALUES (NEW.id, NEW.thread_id, NEW.turn_id, NEW.branch_id,
      CASE WHEN NEW.status IN ('pushed', 'discarded') THEN 'complete' ELSE 'pending' END);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER enlist_turn_trail_work AFTER INSERT ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION enlist_turn_trail_work();
--> statement-breakpoint
CREATE FUNCTION complete_turn_trail_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('pushed', 'discarded') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE turn_trail_work SET state = 'complete', updated_at = now(), last_error = NULL
    WHERE journal_id = NEW.id;
  ELSIF NEW.status = 'active' AND OLD.status = 'discarded' THEN
    UPDATE turn_trail_work SET state = 'pending', next_attempt_at = now(), updated_at = now()
    WHERE journal_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER complete_turn_trail_work AFTER UPDATE OF status ON branch_write_journal
FOR EACH ROW EXECUTE FUNCTION complete_turn_trail_work();

--> statement-breakpoint
-- Single-owner trigger maintenance for threads.last_activity_at and
-- threads.conversational_leaf_turn_id (see domains/threads/.context/CONTEXT.md
-- "Chat activity projection"). No application writer recomputes these columns;
-- every path that can move the visible conversational head (turn creation,
-- turn status/completion, a custom system block, or a direct
-- active_leaf_turn_id move such as a future branch switch) runs through one of
-- the triggers below, which all call the same recompute function.
CREATE FUNCTION recompute_thread_chat_activity(p_thread_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Lock first, then recompute in a separate statement: under READ COMMITTED a
  -- single UPDATE that waits on a concurrent writer re-checks the thread row
  -- but keeps its pre-wait snapshot of turns, so it could write a stale head.
  -- NO KEY UPDATE stays compatible with the FK KEY SHARE a Work-notice
  -- insert takes on this same thread row (thread-work-lock.ts's lock mode).
  PERFORM 1 FROM threads WHERE id = p_thread_id FOR NO KEY UPDATE;
  -- Canonical visible-conversational-head predicate. Kept in lockstep with
  -- isVisibleConversationalTurn (apps/server/.../domain/visible-conversation-policy.ts):
  -- a subagent_update system turn and an inbox_message or Work-context user turn
  -- never anchor the head; every other assistant/user turn does, and a system
  -- turn otherwise needs a custom block.
  UPDATE threads t SET (conversational_leaf_turn_id, last_activity_at) = (
    SELECT conversational_head.turn_id, COALESCE(conversational_head.activity_at, t.created_at)
    FROM (SELECT 1) AS anchor
    LEFT JOIN LATERAL (
      WITH RECURSIVE lineage AS (
        SELECT tr.id, tr.parent_turn_id, tr.role, tr.metadata, tr.created_at, tr.completed_at,
          0 AS depth, ARRAY[tr.id]::uuid[] AS path
        FROM turns tr WHERE tr.id = t.active_leaf_turn_id
        UNION ALL
        SELECT parent.id, parent.parent_turn_id, parent.role, parent.metadata,
          parent.created_at, parent.completed_at, l.depth + 1, l.path || parent.id
        FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
        WHERE NOT parent.id = ANY(l.path)
      )
      SELECT l.id AS turn_id, COALESCE(l.completed_at, l.created_at) AS activity_at
      FROM lineage l
      WHERE (
        l.role = 'assistant'
        OR (l.role = 'user' AND NOT (
          COALESCE(l.metadata->>'kind', '') = 'inbox_message'
          OR (
            COALESCE(l.metadata->>'kind', '') = 'system_update'
            AND COALESCE(l.metadata->>'section', '') = 'work_context'
          )
        ))
        OR (
          l.role = 'system'
          AND COALESCE(l.metadata->>'kind', '') <> 'subagent_update'
          AND EXISTS (
            SELECT 1 FROM turn_blocks visible_custom_block
            WHERE visible_custom_block.turn_id = l.id
              AND visible_custom_block.block_type = 'custom'
          )
        )
      )
      ORDER BY l.depth LIMIT 1
    ) AS conversational_head ON true
  )
  WHERE t.id = p_thread_id;
END;
$$;
--> statement-breakpoint
-- A thread's own active_leaf_turn_id move (turn creation setting the new leaf,
-- or a future branch switch writing it directly) is the single trigger that
-- must fire regardless of which writer performs it.
CREATE FUNCTION recompute_thread_chat_activity_from_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_active_leaf
AFTER UPDATE OF active_leaf_turn_id ON threads
FOR EACH ROW
WHEN (NEW.active_leaf_turn_id IS DISTINCT FROM OLD.active_leaf_turn_id)
EXECUTE FUNCTION recompute_thread_chat_activity_from_thread();
--> statement-breakpoint
-- A turn's creation, or a change to a column the head predicate reads
-- (role/metadata for visibility, status/completed_at for the activity
-- timestamp), can change which turn is the visible head.
CREATE FUNCTION recompute_thread_chat_activity_from_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_turn
AFTER INSERT OR UPDATE OF role, metadata, status, completed_at ON turns
FOR EACH ROW EXECUTE FUNCTION recompute_thread_chat_activity_from_turn();
--> statement-breakpoint
-- A system turn becomes (or stops being) visible only through a custom block.
-- The WHEN clauses keep every other block write (streaming text/tool content,
-- and non-custom upserts) from invoking the function at all.
CREATE FUNCTION recompute_thread_chat_activity_from_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_thread_id uuid;
BEGIN
  SELECT thread_id INTO v_thread_id FROM turns WHERE id = NEW.turn_id;
  IF v_thread_id IS NOT NULL THEN
    PERFORM recompute_thread_chat_activity(v_thread_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_block_insert
AFTER INSERT ON turn_blocks
FOR EACH ROW
WHEN (NEW.block_type = 'custom')
EXECUTE FUNCTION recompute_thread_chat_activity_from_block_insert();
--> statement-breakpoint
CREATE FUNCTION recompute_thread_chat_activity_from_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_new_thread_id uuid;
  v_old_thread_id uuid;
BEGIN
  SELECT thread_id INTO v_new_thread_id FROM turns WHERE id = NEW.turn_id;
  IF v_new_thread_id IS NOT NULL THEN
    PERFORM recompute_thread_chat_activity(v_new_thread_id);
  END IF;
  IF OLD.turn_id IS DISTINCT FROM NEW.turn_id THEN
    SELECT thread_id INTO v_old_thread_id FROM turns WHERE id = OLD.turn_id;
    IF v_old_thread_id IS NOT NULL AND v_old_thread_id IS DISTINCT FROM v_new_thread_id THEN
      PERFORM recompute_thread_chat_activity(v_old_thread_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recompute_thread_chat_activity_on_block_update
AFTER UPDATE OF block_type, turn_id ON turn_blocks
FOR EACH ROW
WHEN (NEW.block_type = 'custom' OR OLD.block_type = 'custom')
EXECUTE FUNCTION recompute_thread_chat_activity_from_block_update();
