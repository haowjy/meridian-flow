CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_bigm;
--> statement-breakpoint
CREATE SEQUENCE "public"."branch_tree_change_revision" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."context_availability_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."context_namespace_observation_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
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
	"invoked_skills" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
	"price_source" text DEFAULT 'computed' NOT NULL,
	"pricing_snapshot" jsonb,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"reasoning_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cache_reset" boolean DEFAULT false NOT NULL,
	"usage_breakdown" jsonb DEFAULT '{}'::jsonb,
	"cost_usd" numeric(12, 6),
	"millicredits" bigint,
	"stop_reason" text,
	"request_params" jsonb,
	"response_metadata" jsonb,
	"latency_ms" bigint,
	"request_message_count" integer NOT NULL,
	"request_started_at" timestamp with time zone,
	"predicted_cache_state" text NOT NULL,
	"predicted_cache_reason" text NOT NULL,
	"time_to_first_token_ms" bigint,
	"generation_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_responses_price_source_valid" CHECK ("model_responses"."price_source" IN ('computed', 'unknown')),
	CONSTRAINT "model_responses_predicted_cache_state_valid" CHECK ("model_responses"."predicted_cache_state" IN ('warm', 'cold')),
	CONSTRAINT "model_responses_predicted_cache_reason_valid" CHECK ("model_responses"."predicted_cache_reason" IN ('reusable_prefix', 'no_response', 'model_changed', 'prompt_epoch', 'media_eviction', 'media_link_window', 'compaction', 'ttl_unknown', 'ttl_expired', 'summary_transcript', 'fork_cutoff', 'fork_bake_changed', 'facts_unavailable'))
);
--> statement-breakpoint
CREATE TABLE "observation_frontiers" (
	"source_block_id" uuid PRIMARY KEY NOT NULL,
	"room_key" text NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"journal_position" bigint,
	"recorded_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "observation_frontiers_recorded_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "project_handle_counters" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "project_handle_counters_project_id_kind_pk" PRIMARY KEY("project_id","kind"),
	CONSTRAINT "project_handle_counters_kind_valid" CHECK ("project_handle_counters"."kind" IN ('thread', 'work'))
);
--> statement-breakpoint
CREATE TABLE "prompt_bakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_thread_id" uuid NOT NULL,
	"composed_system_prompt" text NOT NULL,
	"baked_skill_slugs" jsonb NOT NULL,
	"baked_tools" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"execution_turn_id" uuid PRIMARY KEY NOT NULL,
	"terminal_turn_id" uuid,
	"child_thread_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"origin" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"caller_thread_id" uuid,
	"caller_turn_id" uuid,
	"tool_call_id" text,
	"card_block_id" uuid,
	"agent_slug" text,
	"name" text,
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
	"notice_withdrawn" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_execution_reports_origin_valid" CHECK ("thread_execution_reports"."origin" IN ('spawn','message','thread_run')),
	CONSTRAINT "thread_execution_reports_delivery_valid" CHECK ("thread_execution_reports"."delivery_mode" IN ('background_notification','direct','none')),
	CONSTRAINT "thread_execution_reports_origin_delivery_valid" CHECK (("thread_execution_reports"."origin" IN ('spawn','message') AND "thread_execution_reports"."delivery_mode" IN ('background_notification','direct')) OR ("thread_execution_reports"."origin" = 'thread_run' AND "thread_execution_reports"."delivery_mode" = 'none')),
	CONSTRAINT "thread_execution_reports_capture_call_coherent" CHECK (("thread_execution_reports"."capture" IS NULL AND "thread_execution_reports"."capture_tool_call_id" IS NULL) OR ("thread_execution_reports"."capture" IS NOT NULL AND "thread_execution_reports"."capture_tool_call_id" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_outcome_valid" CHECK ("thread_execution_reports"."outcome" IS NULL OR "thread_execution_reports"."outcome" IN ('succeeded','failed','cancelled')),
	CONSTRAINT "thread_execution_reports_source_valid" CHECK ("thread_execution_reports"."source" IS NULL OR "thread_execution_reports"."source" IN ('return_result','final_assistant','empty')),
	CONSTRAINT "thread_execution_reports_publication_valid" CHECK ("thread_execution_reports"."publication" IN ('none','pending','published')),
	CONSTRAINT "thread_execution_reports_pending_has_caller" CHECK ("thread_execution_reports"."publication" <> 'pending' OR "thread_execution_reports"."caller_thread_id" IS NOT NULL),
	CONSTRAINT "thread_execution_reports_terminal_coherent" CHECK (("thread_execution_reports"."outcome" IS NULL AND "thread_execution_reports"."terminal_at" IS NULL) OR ("thread_execution_reports"."outcome" IS NOT NULL AND "thread_execution_reports"."source" IS NOT NULL AND "thread_execution_reports"."summary" IS NOT NULL AND "thread_execution_reports"."terminal_at" IS NOT NULL)),
	CONSTRAINT "thread_execution_reports_publication_timestamp_coherent" CHECK (("thread_execution_reports"."publication" IN ('none','pending') AND "thread_execution_reports"."published_at" IS NULL) OR ("thread_execution_reports"."publication" = 'published' AND "thread_execution_reports"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "thread_hand_backs" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"handed_back" uuid[] NOT NULL,
	"answered" uuid[] NOT NULL,
	"gone" uuid[] NOT NULL,
	"cancelled_execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"delivered_by_turn_id" uuid,
	"handed_back_by" uuid,
	CONSTRAINT "thread_inbox_messages_idem_unique" UNIQUE("thread_id","idempotency_key"),
	CONSTRAINT "thread_inbox_messages_hand_back" CHECK ("thread_inbox_messages"."handed_back_by" IS NULL OR ("thread_inbox_messages"."delivered_at" IS NOT NULL AND "thread_inbox_messages"."delivered_by_turn_id" IS NULL AND "thread_inbox_messages"."intent" = 'message')),
	CONSTRAINT "thread_inbox_messages_intent_valid" CHECK ("thread_inbox_messages"."intent" IN ('message','notice','control')),
	CONSTRAINT "thread_inbox_messages_provenance_valid" CHECK (("thread_inbox_messages"."provenance"->>'kind' IN ('writer','agent','child','system')) IS TRUE),
	CONSTRAINT "thread_inbox_messages_body_valid" CHECK ((CASE WHEN "thread_inbox_messages"."intent" = 'control' THEN ("thread_inbox_messages"."body"->>'kind' IN ('compact','ask_resolved') OR ("thread_inbox_messages"."body"->>'kind' = 'write_mode' AND "thread_inbox_messages"."body"->>'mode' IN ('direct','draft'))) ELSE "thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh') END) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "thread_media_inclusions" (
	"thread_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"decision_turn_id" uuid NOT NULL,
	"included" boolean NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_media_inclusions_thread_id_block_id_part_index_decision_turn_id_pk" PRIMARY KEY("thread_id","block_id","part_index","decision_turn_id")
);
--> statement-breakpoint
CREATE TABLE "thread_run_leases" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"bound_turn_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"adopted_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"turn_id" uuid,
	"holder_id" text NOT NULL,
	"phase" text DEFAULT 'generating' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"current_tool" jsonb,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_run_leases_phase_valid" CHECK ("thread_run_leases"."phase" IN ('generating','waiting','compacting'))
);
--> statement-breakpoint
CREATE TABLE "thread_shown_links" (
	"thread_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"address" text NOT NULL,
	"holder_uri" text NOT NULL,
	"view" text NOT NULL,
	"showing_digest" text NOT NULL,
	"turn_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "thread_shown_links_pk" PRIMARY KEY("thread_id","document_id","showing_digest","turn_id"),
	CONSTRAINT "thread_shown_links_digest_valid" CHECK ("thread_shown_links"."showing_digest" ~ '^[0-9a-f]{64}$')
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
	"initial_prompt_bake_id" uuid,
	"parent_thread_id" uuid,
	"root_thread_id" uuid NOT NULL,
	"origin_turn_id" uuid,
	"origin_type" text,
	"spawn_status" text,
	"spawn_depth" integer DEFAULT 0 NOT NULL,
	"active_leaf_turn_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"conversational_leaf_turn_id" uuid,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"inbox_blocked_reason" text,
	"wake_fence_at" timestamp with time zone,
	"next_seq" bigint DEFAULT 0 NOT NULL,
	"ai_write_mode" text DEFAULT 'direct' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_work_id" uuid,
	CONSTRAINT "threads_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "threads_no_self_parent" CHECK ("threads"."id" != "threads"."parent_thread_id"),
	CONSTRAINT "threads_spawn_depth_nonneg" CHECK ("threads"."spawn_depth" >= 0),
	CONSTRAINT "threads_next_seq_nonneg" CHECK ("threads"."next_seq" >= 0),
	CONSTRAINT "threads_ai_write_mode_valid" CHECK ("threads"."ai_write_mode" IN ('direct', 'draft')),
	CONSTRAINT "threads_kind_valid" CHECK ("threads"."kind" IN ('primary', 'subagent')),
	CONSTRAINT "threads_status_valid" CHECK ("threads"."status" IN ('idle', 'archived')),
	CONSTRAINT "threads_origin_type_valid" CHECK ("threads"."origin_type" IS NULL OR "threads"."origin_type" IN ('spawn', 'handoff', 'fork')),
	CONSTRAINT "threads_spawn_origin_subagent" CHECK ("threads"."origin_type" != 'spawn' OR "threads"."kind" = 'subagent'),
	CONSTRAINT "threads_spawn_origin_required_fields" CHECK ("threads"."origin_type" != 'spawn' OR ("threads"."kind" = 'subagent' AND "threads"."parent_thread_id" IS NOT NULL AND "threads"."origin_turn_id" IS NOT NULL AND "threads"."spawn_status" IS NOT NULL)),
	CONSTRAINT "threads_handoff_origin_turn_required" CHECK ("threads"."origin_type" <> 'handoff' OR "threads"."origin_turn_id" IS NOT NULL),
	CONSTRAINT "threads_handoff_fork_primary" CHECK ("threads"."origin_type" NOT IN ('handoff', 'fork') OR "threads"."kind" = 'primary'),
	CONSTRAINT "threads_fork_origin_required_fields" CHECK ("threads"."origin_type" != 'fork' OR "threads"."origin_turn_id" IS NOT NULL),
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
	"execution_side" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_blocks_status_valid" CHECK ("turn_blocks"."status" IN ('complete', 'partial')),
	CONSTRAINT "turn_blocks_block_type_valid" CHECK ("turn_blocks"."block_type" IN ('text', 'media', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_turn_id" uuid,
	"position" integer NOT NULL,
	"prompt_bake_id" uuid,
	"compaction_model" text,
	"role" text NOT NULL,
	"origin" text NOT NULL,
	"ai_write_mode" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"execution_id" uuid,
	"reserved_for_user_turn_ids" uuid[],
	"forgotten_by_turn_id" uuid,
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
	CONSTRAINT "turns_position_positive" CHECK ("turns"."position" > 0),
	CONSTRAINT "turns_role_valid" CHECK ("turns"."role" IN ('user', 'assistant', 'system', 'compaction')),
	CONSTRAINT "turns_origin_valid" CHECK ("turns"."origin" IN ('writer', 'assistant', 'system')),
	CONSTRAINT "turns_ai_write_mode_valid" CHECK ("turns"."ai_write_mode" IS NULL OR "turns"."ai_write_mode" IN ('direct', 'draft')),
	CONSTRAINT "turns_status_valid" CHECK ("turns"."status" IN ('pending', 'streaming', 'awaiting_answer', 'complete', 'cancelled', 'error')),
	CONSTRAINT "turns_compaction_model_required" CHECK ("turns"."role" != 'compaction' OR "turns"."status" != 'complete' OR "turns"."compaction_model" IS NOT NULL)
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
	"run_state_version" text,
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
CREATE TABLE "branch_tree_changes" (
	"branch_id" uuid NOT NULL,
	"node_kind" text NOT NULL,
	"node_id" uuid NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"created_thread_id" uuid,
	"created_turn_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"moved" boolean DEFAULT false NOT NULL,
	"moved_folder_id" uuid,
	"moved_root_source_id" uuid,
	"moved_name" text,
	"moved_extension" text,
	"moved_rank" text,
	"base_version" bigint,
	"revision" bigint DEFAULT nextval('branch_tree_change_revision'),
	"changed_thread_id" uuid,
	"changed_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_tree_changes_branch_id_node_kind_node_id_pk" PRIMARY KEY("branch_id","node_kind","node_id"),
	CONSTRAINT "branch_tree_changes_node_kind_valid" CHECK ("branch_tree_changes"."node_kind" IN ('document', 'folder')),
	CONSTRAINT "branch_tree_changes_says_something" CHECK ("branch_tree_changes"."created" OR "branch_tree_changes"."moved" OR "branch_tree_changes"."deleted"),
	CONSTRAINT "branch_tree_changes_tree_facts_documents" CHECK (NOT ("branch_tree_changes"."moved" OR "branch_tree_changes"."deleted") OR "branch_tree_changes"."node_kind" = 'document'),
	CONSTRAINT "branch_tree_changes_moved_shape" CHECK (CASE WHEN "branch_tree_changes"."moved" THEN "branch_tree_changes"."moved_name" IS NOT NULL AND "branch_tree_changes"."moved_extension" IS NOT NULL
        AND ("branch_tree_changes"."moved_folder_id" IS NULL) <> ("branch_tree_changes"."moved_root_source_id" IS NULL)
        ELSE "branch_tree_changes"."moved_folder_id" IS NULL AND "branch_tree_changes"."moved_root_source_id" IS NULL
          AND "branch_tree_changes"."moved_name" IS NULL AND "branch_tree_changes"."moved_extension" IS NULL END),
	CONSTRAINT "branch_tree_changes_revision_present" CHECK (NOT ("branch_tree_changes"."moved" OR "branch_tree_changes"."deleted") OR "branch_tree_changes"."revision" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "branch_tree_folders" (
	"branch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	CONSTRAINT "branch_tree_folders_branch_id_document_id_folder_id_pk" PRIMARY KEY("branch_id","document_id","folder_id")
);
--> statement-breakpoint
CREATE TABLE "branch_tree_parent_orders" (
	"branch_id" uuid NOT NULL,
	"parent_kind" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_tree_parent_orders_branch_id_parent_kind_parent_id_pk" PRIMARY KEY("branch_id","parent_kind","parent_id"),
	CONSTRAINT "branch_tree_parent_orders_kind_valid" CHECK ("branch_tree_parent_orders"."parent_kind" IN ('source', 'folder'))
);
--> statement-breakpoint
CREATE TABLE "branch_tree_ranks" (
	"branch_id" uuid NOT NULL,
	"parent_kind" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"node_kind" text NOT NULL,
	"node_id" uuid NOT NULL,
	"rank" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_tree_ranks_branch_id_node_kind_node_id_pk" PRIMARY KEY("branch_id","node_kind","node_id"),
	CONSTRAINT "branch_tree_ranks_parent_kind_valid" CHECK ("branch_tree_ranks"."parent_kind" IN ('source', 'folder')),
	CONSTRAINT "branch_tree_ranks_kind_valid" CHECK ("branch_tree_ranks"."node_kind" IN ('document', 'folder'))
);
--> statement-breakpoint
CREATE TABLE "branch_tree_unsettled" (
	"branch_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "branch_tree_unsettled_branch_id_document_id_pk" PRIMARY KEY("branch_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin_thread_id" uuid,
	"origin_work_id" uuid,
	"origin_root_thread_id" uuid,
	"pending_document_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "branches_one_owner" CHECK (num_nonnulls("branches"."origin_work_id", "branches"."origin_root_thread_id") <= 1 AND ("branches"."status" = 'closed' OR num_nonnulls("branches"."origin_work_id", "branches"."origin_root_thread_id") = 1)),
	CONSTRAINT "branches_status_valid" CHECK ("branches"."status" IN ('active', 'closed')),
	CONSTRAINT "branches_closed_shape" CHECK (("branches"."status" = 'closed') = ("branches"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "context_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"work_id" uuid,
	"root_thread_id" uuid,
	"chat_thread_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_work_id" uuid,
	CONSTRAINT "context_sources_exactly_one_scope" CHECK (("context_sources"."scope" = 'project' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NULL) OR ("context_sources"."scope" = 'work' AND "context_sources"."project_id" IS NULL AND "context_sources"."work_id" IS NOT NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NULL) OR ("context_sources"."scope" = 'lineage' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NOT NULL AND "context_sources"."chat_thread_id" IS NULL AND "context_sources"."slug" = 'scratch') OR ("context_sources"."scope" = 'chat' AND "context_sources"."project_id" IS NOT NULL AND "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NOT NULL AND "context_sources"."slug" = 'uploads')),
	CONSTRAINT "context_sources_uploads_chat_only" CHECK ("context_sources"."slug" <> 'uploads' OR "context_sources"."scope" = 'chat'),
	CONSTRAINT "context_sources_scope_valid" CHECK ("context_sources"."scope" IN ('project', 'work', 'lineage', 'chat')),
	CONSTRAINT "context_sources_scope_work_fk" CHECK ("context_sources"."scope" <> 'work' OR "context_sources"."work_id" IS NOT NULL),
	CONSTRAINT "context_sources_scope_project_fk" CHECK ("context_sources"."scope" = 'work' OR "context_sources"."work_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "document_forwards" (
	"from_document_id" uuid PRIMARY KEY NOT NULL,
	"to_document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"source_document_id" uuid NOT NULL,
	"link_key" text NOT NULL,
	"target_document_id" uuid,
	"ahead_id" uuid,
	"address" text,
	"occurrences" integer NOT NULL,
	CONSTRAINT "document_links_source_document_id_link_key_pk" PRIMARY KEY("source_document_id","link_key")
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
	"context_source_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"extension" text DEFAULT '' NOT NULL,
	"file_type" text DEFAULT 'markdown' NOT NULL,
	"description" text,
	"storage_url" text,
	"mime_type" text,
	"size_bytes" bigint,
	"has_preview" boolean DEFAULT false NOT NULL,
	"location_version" bigint DEFAULT 0 NOT NULL,
	"provisional_name" boolean DEFAULT false NOT NULL,
	"rank" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"content_purged_at" timestamp with time zone,
	"deletion_reason" text,
	"deleted_by_user_id" uuid,
	"deletion_cause" text,
	"deleted_by_work_id" uuid,
	"deleted_by_thread_id" uuid,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "documents_stored_mime_type" CHECK ("documents"."storage_url" IS NULL OR "documents"."mime_type" IS NOT NULL),
	CONSTRAINT "documents_removal_presence" CHECK (("documents"."deleted_at" IS NOT NULL) = ("documents"."deletion_reason" IS NOT NULL)),
	CONSTRAINT "documents_deletion_reason_valid" CHECK ("documents"."deletion_reason" IN ('deleted', 'discarded')),
	CONSTRAINT "documents_deletion_cause_valid" CHECK ("documents"."deletion_cause" IN ('reply_rolled_back', 'create_failed', 'repair')),
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
	"rank" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_work_id" uuid,
	"hidden" boolean DEFAULT false NOT NULL,
	"absorbed_into" uuid,
	"location_version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_ahead_refs" (
	"ahead_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"scheme" text NOT NULL,
	"work_id" uuid,
	"root_thread_id" uuid,
	"chat_thread_id" uuid,
	"path" text NOT NULL,
	"settled_document_id" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
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
	"owner_thread_id" uuid,
	"context_source_id" uuid,
	"document_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"final_path" text,
	"object_key" text NOT NULL,
	"file_type" text,
	"size_bytes" bigint NOT NULL,
	"location_revision" uuid NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intakes_project_intake_unique" UNIQUE("project_id","intake_id"),
	CONSTRAINT "upload_intakes_document_unique" UNIQUE("document_id"),
	CONSTRAINT "upload_intakes_state_valid" CHECK ("upload_intakes"."state" IN ('reserved', 'object_stored', 'finalized', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handle" text,
	"is_no_work" boolean DEFAULT false NOT NULL,
	"goal" text,
	"status" text,
	"archived_at" timestamp with time zone,
	"default_ai_write_mode" text DEFAULT 'direct' NOT NULL,
	"entity_revision" bigint DEFAULT 1 NOT NULL,
	"pending_document_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "works_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "works_name_nonempty" CHECK (btrim("works"."name") <> ''),
	CONSTRAINT "works_no_work_handle" CHECK (("works"."is_no_work" AND "works"."handle" IS NULL) OR (NOT "works"."is_no_work" AND "works"."handle" IS NOT NULL)),
	CONSTRAINT "works_no_work_not_archived" CHECK (NOT "works"."is_no_work" OR "works"."archived_at" IS NULL),
	CONSTRAINT "works_handle_valid" CHECK ("works"."handle" IS NULL OR "works"."handle" ~ '^w[1-9][0-9]*$'),
	CONSTRAINT "works_status_length" CHECK ("works"."status" IS NULL OR char_length("works"."status") <= 32),
	CONSTRAINT "works_default_ai_write_mode_valid" CHECK ("works"."default_ai_write_mode" IN ('direct', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "context_availability_heads" (
	"authority_key" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL,
	"namespace_generation" bigint DEFAULT 0 NOT NULL,
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
CREATE TABLE "context_staged_documents" (
	"staging_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"parent_id" uuid,
	"area" text NOT NULL,
	"name" text NOT NULL,
	"extension" text NOT NULL,
	"filetype" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"storage_url" text,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"has_preview" boolean DEFAULT false NOT NULL,
	"ahead_mints" jsonb NOT NULL,
	CONSTRAINT "context_staged_documents_staging_id_id_pk" PRIMARY KEY("staging_id","id")
);
--> statement-breakpoint
CREATE TABLE "context_staged_folders" (
	"staging_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"parent_id" uuid,
	"area" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "context_staged_folders_staging_id_id_pk" PRIMARY KEY("staging_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_edit_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"edit_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"update" "bytea" NOT NULL,
	"effect" jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frontier" jsonb NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" jsonb NOT NULL,
	CONSTRAINT "document_edit_parts_ordinal_valid" CHECK ("document_edit_parts"."ordinal" >= 0),
	CONSTRAINT "document_edit_parts_origin_valid" CHECK ("document_edit_parts"."origin"->>'kind' IN ('pending','live'))
);
--> statement-breakpoint
CREATE TABLE "document_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"thread_id" uuid,
	"turn_id" uuid,
	"response_id" text,
	"edit_scope_id" text,
	"tool_call_id" text,
	"actor" text NOT NULL,
	"actor_user_id" uuid,
	"w_id" integer,
	"kind" text NOT NULL,
	"action_id" uuid,
	"consumes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tree_change" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_edits_actor_valid" CHECK ("document_edits"."actor" IN ('agent','human','system')),
	CONSTRAINT "document_edits_kind_valid" CHECK ("document_edits"."kind" IN ('write','undo','redo','revert','rollback')),
	CONSTRAINT "document_edits_tree_change_valid" CHECK ("document_edits"."tree_change" IS NULL OR (
        "document_edits"."tree_change"->>'op' IN ('create','move','delete','restore','settle')
        AND "document_edits"."tree_change"->'destination'->>'kind' IN ('live','draft')
        AND jsonb_typeof("document_edits"."tree_change"->'seq') = 'number'
        AND jsonb_typeof("document_edits"."tree_change"->'targets') = 'array'
        AND ("document_edits"."tree_change"->>'op' <> 'settle' OR "document_edits"."tree_change" ? 'settles')
      ))
);
--> statement-breakpoint
CREATE TABLE "import_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"kind" text NOT NULL,
	"entry_id" integer,
	"state" text NOT NULL,
	"reason" text,
	"changed_after_upload" boolean DEFAULT false NOT NULL,
	"storage_url" text,
	"object_key" text,
	"converted_key" text,
	"received_size" bigint,
	"sha256" text
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"user_id" uuid NOT NULL,
	"destination_uri" text NOT NULL,
	"folder_id" uuid,
	"roots" jsonb NOT NULL,
	"placement" jsonb,
	"placement_generation" integer DEFAULT 0 NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"counts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"claims_without_progress" integer DEFAULT 0 NOT NULL,
	"fell_back" boolean DEFAULT false NOT NULL,
	"reason" text,
	"revealed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"objects_swept_at" timestamp with time zone,
	"final_sweep_at" timestamp with time zone
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
	"deleted_by_work_id" uuid,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_results_size_bytes_nonneg" CHECK ("project_results"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"asking_turn_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"permission_command" jsonb,
	"opened_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"draft_answers" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" jsonb,
	"submission_id" text,
	"continuation" text,
	"continuation_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "asks_turn_tool_call_unique" UNIQUE("asking_turn_id","tool_call_id"),
	CONSTRAINT "asks_kind_valid" CHECK ("asks"."kind" IN ('question', 'permission')),
	CONSTRAINT "asks_permission_command_coherent" CHECK (("asks"."kind" = 'permission' AND "asks"."permission_command" IS NOT NULL) OR ("asks"."kind" = 'question' AND "asks"."permission_command" IS NULL)),
	CONSTRAINT "asks_status_valid" CHECK ("asks"."status" IN ('pending', 'open', 'answered', 'expired', 'cancelled')),
	CONSTRAINT "asks_resolution_coherent" CHECK (("asks"."status" IN ('pending', 'open') AND "asks"."resolution" IS NULL AND "asks"."resolved_at" IS NULL) OR ("asks"."status" IN ('answered', 'expired', 'cancelled') AND "asks"."resolution" IS NOT NULL AND "asks"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "project_action_grants" (
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_action_grants_project_action_unique" UNIQUE("project_id","action")
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
CREATE TABLE "agent_edit_wid_counters" (
	"document_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"next_wid" integer NOT NULL,
	CONSTRAINT "agent_edit_wid_counters_document_id_thread_id_pk" PRIMARY KEY("document_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "apply_command_effects" (
	"command_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"group_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"draft_id" text NOT NULL,
	"live_update_seq" bigint,
	"base_start" jsonb,
	"base_delta" jsonb NOT NULL,
	"unapplied_by" uuid,
	CONSTRAINT "apply_command_effects_command_id_ordinal_pk" PRIMARY KEY("command_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "branch_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "branch_commands_kind_valid" CHECK ("branch_commands"."kind" IN ('apply_click', 'unapply_click', 'discard_items', 'discard_branch')),
	CONSTRAINT "branch_commands_state_valid" CHECK ("branch_commands"."state" IN ('pending', 'done')),
	CONSTRAINT "branch_commands_done_shape" CHECK (("branch_commands"."state" = 'done') = ("branch_commands"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "collab_staged_states" (
	"staging_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"attribution_manifest" jsonb NOT NULL,
	CONSTRAINT "collab_staged_states_staging_id_document_id_pk" PRIMARY KEY("staging_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "document_block_rooms" (
	"room_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "document_block_rooms_room_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"block_order" text[] NOT NULL,
	"word_count" integer NOT NULL,
	"document_hash" "bytea" NOT NULL,
	"cut_generation" bigint NOT NULL,
	"cut_admission_seq" bigint NOT NULL,
	"cut_location_version" bigint NOT NULL,
	"extractor_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_blocks" (
	"room_id" bigint NOT NULL,
	"block_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"text" text NOT NULL,
	"content_hash" "bytea" NOT NULL,
	CONSTRAINT "document_blocks_room_id_block_id_pk" PRIMARY KEY("room_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "document_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"upstream_draft_id" text,
	"branch_id" uuid NOT NULL,
	"thread_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"closed_cause" text,
	"state" "bytea" NOT NULL,
	"state_vector" "bytea" NOT NULL,
	"seed_origins" jsonb,
	"seed_live_room" text,
	"seed_live_snapshot" "bytea",
	"seed_draft_snapshot" "bytea",
	"seed_live_state" "bytea",
	"seed_live_position" bigint,
	"has_effect" boolean DEFAULT true NOT NULL,
	"has_effect_revision" bigint DEFAULT -1 NOT NULL,
	"schema_version" integer DEFAULT 2000000 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"checkpoint_revision" bigint DEFAULT 0 NOT NULL,
	"checkpoint_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_drafts_kind_valid" CHECK ("document_drafts"."kind" IN ('work_draft', 'thread_peer')),
	CONSTRAINT "document_drafts_closed_cause_presence" CHECK (("document_drafts"."status" = 'closed') = ("document_drafts"."closed_cause" IS NOT NULL)),
	CONSTRAINT "document_drafts_closed_cause_valid" CHECK ("document_drafts"."closed_cause" IN ('discarded', 'document_removed')),
	CONSTRAINT "document_drafts_status_valid" CHECK ("document_drafts"."status" IN ('active', 'closed')),
	CONSTRAINT "document_drafts_seed_record_shape" CHECK ((("document_drafts"."seed_origins" IS NULL AND "document_drafts"."seed_live_room" IS NULL AND "document_drafts"."seed_live_snapshot" IS NULL AND "document_drafts"."seed_draft_snapshot" IS NULL) OR ("document_drafts"."kind" = 'work_draft' AND "document_drafts"."seed_origins" IS NOT NULL AND "document_drafts"."seed_live_room" IS NOT NULL AND "document_drafts"."seed_live_snapshot" IS NOT NULL AND "document_drafts"."seed_draft_snapshot" IS NOT NULL)) AND (("document_drafts"."seed_live_state" IS NULL AND "document_drafts"."seed_live_position" IS NULL) OR ("document_drafts"."seed_live_state" IS NOT NULL AND "document_drafts"."seed_live_position" IS NOT NULL))),
	CONSTRAINT "document_drafts_owner_shape" CHECK (("document_drafts"."kind" = 'work_draft' AND "document_drafts"."thread_id" IS NULL) OR ("document_drafts"."kind" = 'thread_peer' AND "document_drafts"."thread_id" IS NOT NULL))
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
	"schema_version" integer DEFAULT 2000000 NOT NULL,
	"retired_through_seq" bigint DEFAULT 0 NOT NULL,
	"latest_update_seq" bigint DEFAULT 0 NOT NULL,
	"latest_state_vector" "bytea",
	"latest_checkpoint_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"edit_id" uuid,
	"edit_part_ordinal" integer,
	"origin_type" text,
	"actor_user_id" uuid,
	"actor_turn_id" uuid,
	"authoring_response_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_write_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"w_id" integer,
	"tool_call_id" text,
	"source" text DEFAULT 'agent' NOT NULL,
	"thread_id" uuid,
	"turn_id" uuid,
	"actor_user_id" uuid,
	"update_data" "bytea" NOT NULL,
	"update_meta" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_write_journal_source_valid" CHECK ("draft_write_journal"."source" IN ('agent', 'writer', 'server')),
	CONSTRAINT "draft_write_journal_status_valid" CHECK ("draft_write_journal"."status" IN ('active', 'rollback_pending'))
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
ALTER TABLE "observation_frontiers" ADD CONSTRAINT "observation_frontiers_source_block_id_turn_blocks_id_fk" FOREIGN KEY ("source_block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_handle_counters" ADD CONSTRAINT "project_handle_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_bakes" ADD CONSTRAINT "prompt_bakes_owner_thread_id_threads_id_fk" FOREIGN KEY ("owner_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_documents" ADD CONSTRAINT "thread_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_execution_turn_id_turns_id_fk" FOREIGN KEY ("execution_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_terminal_turn_id_turns_id_fk" FOREIGN KEY ("terminal_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_thread_id_threads_id_fk" FOREIGN KEY ("child_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_thread_id_threads_id_fk" FOREIGN KEY ("caller_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_caller_turn_id_turns_id_fk" FOREIGN KEY ("caller_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_card_block_id_turn_blocks_id_fk" FOREIGN KEY ("card_block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_child_turn_fk" FOREIGN KEY ("child_thread_id","execution_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_hand_backs" ADD CONSTRAINT "thread_hand_backs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_handed_back_by_fk" FOREIGN KEY ("handed_back_by") REFERENCES "public"."thread_hand_backs"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_media_inclusions" ADD CONSTRAINT "thread_media_inclusions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_media_inclusions" ADD CONSTRAINT "thread_media_inclusions_block_id_turn_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."turn_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_media_inclusions" ADD CONSTRAINT "thread_media_inclusions_decision_turn_id_turns_id_fk" FOREIGN KEY ("decision_turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_run_leases" ADD CONSTRAINT "thread_run_leases_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_shown_links" ADD CONSTRAINT "thread_shown_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_user_state" ADD CONSTRAINT "thread_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_thread_same_project_fk" FOREIGN KEY ("project_id","thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_work_same_project_fk" FOREIGN KEY ("project_id","work_id") REFERENCES "public"."works"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_initial_prompt_bake_id_prompt_bakes_id_fk" FOREIGN KEY ("initial_prompt_bake_id") REFERENCES "public"."prompt_bakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_turn_id_turns_id_fk" FOREIGN KEY ("origin_turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_spawn_root_same_project_fk" FOREIGN KEY ("project_id","root_thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_model_response_id_model_responses_id_fk" FOREIGN KEY ("model_response_id") REFERENCES "public"."model_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_prompt_bake_id_prompt_bakes_id_fk" FOREIGN KEY ("prompt_bake_id") REFERENCES "public"."prompt_bakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_forgotten_by_fk" FOREIGN KEY ("thread_id","forgotten_by_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_turn_admissions" ADD CONSTRAINT "user_turn_admissions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_created_thread_id_threads_id_fk" FOREIGN KEY ("created_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_created_turn_id_turns_id_fk" FOREIGN KEY ("created_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_changed_thread_id_threads_id_fk" FOREIGN KEY ("changed_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_changes" ADD CONSTRAINT "branch_tree_changes_changed_turn_id_turns_id_fk" FOREIGN KEY ("changed_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_folders" ADD CONSTRAINT "branch_tree_folders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_parent_orders" ADD CONSTRAINT "branch_tree_parent_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_ranks" ADD CONSTRAINT "branch_tree_ranks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_tree_unsettled" ADD CONSTRAINT "branch_tree_unsettled_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_origin_thread_id_threads_id_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_origin_work_id_works_id_fk" FOREIGN KEY ("origin_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_to_document_id_documents_id_fk" FOREIGN KEY ("to_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_forwards" ADD CONSTRAINT "document_forwards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_previous_locations" ADD CONSTRAINT "document_previous_locations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_thread_id_threads_id_fk" FOREIGN KEY ("deleted_by_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD CONSTRAINT "link_ahead_refs_settled_document_id_documents_id_fk" FOREIGN KEY ("settled_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_context_source_id_context_sources_id_fk" FOREIGN KEY ("context_source_id") REFERENCES "public"."context_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_catalog_commits" ADD CONSTRAINT "context_catalog_commits_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_catalog_entries" ADD CONSTRAINT "context_catalog_entries_scope_key_context_catalog_scope_heads_scope_key_fk" FOREIGN KEY ("scope_key") REFERENCES "public"."context_catalog_scope_heads"("scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_operation_receipts" ADD CONSTRAINT "context_operation_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_staged_documents" ADD CONSTRAINT "context_staged_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_staged_folders" ADD CONSTRAINT "context_staged_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edit_parts" ADD CONSTRAINT "document_edit_parts_edit_id_document_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."document_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entries" ADD CONSTRAINT "import_entries_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recent_documents" ADD CONSTRAINT "user_recent_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_root_thread_id_threads_id_fk" FOREIGN KEY ("root_thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_results" ADD CONSTRAINT "project_results_deleted_by_work_id_works_id_fk" FOREIGN KEY ("deleted_by_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asks" ADD CONSTRAINT "asks_asking_turn_fk" FOREIGN KEY ("thread_id","asking_turn_id") REFERENCES "public"."turns"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_action_grants" ADD CONSTRAINT "project_action_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_project_favorites" ADD CONSTRAINT "user_project_favorites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_working_sets" ADD CONSTRAINT "project_user_working_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_command_effects" ADD CONSTRAINT "apply_command_effects_command_id_branch_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."branch_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apply_command_effects" ADD CONSTRAINT "apply_command_effects_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_commands" ADD CONSTRAINT "branch_commands_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_commands" ADD CONSTRAINT "branch_commands_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_staged_states" ADD CONSTRAINT "collab_staged_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_block_rooms" ADD CONSTRAINT "document_block_rooms_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_room_id_document_block_rooms_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."document_block_rooms"("room_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_upstream_draft_id_document_drafts_id_fk" FOREIGN KEY ("upstream_draft_id") REFERENCES "public"."document_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_checkpoints" ADD CONSTRAINT "document_yjs_checkpoints_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ADD CONSTRAINT "document_yjs_heads_latest_checkpoint_id_document_yjs_checkpoints_id_fk" FOREIGN KEY ("latest_checkpoint_id") REFERENCES "public"."document_yjs_checkpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_edit_id_document_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."document_edits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_yjs_updates" ADD CONSTRAINT "document_yjs_updates_actor_turn_id_turns_id_fk" FOREIGN KEY ("actor_turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_write_journal" ADD CONSTRAINT "draft_write_journal_draft_id_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_write_journal" ADD CONSTRAINT "draft_write_journal_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_write_journal" ADD CONSTRAINT "draft_write_journal_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_write_journal" ADD CONSTRAINT "draft_write_journal_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notices" ADD CONSTRAINT "pending_notices_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "observation_frontiers_room_latest" ON "observation_frontiers" USING btree ("room_key","recorded_seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prompt_bakes_owner_created" ON "prompt_bakes" USING btree ("owner_thread_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_execution_reports_pending" ON "thread_execution_reports" USING btree ("execution_turn_id") WHERE "thread_execution_reports"."publication" = 'pending';--> statement-breakpoint
CREATE INDEX "thread_inbox_messages_handed_back" ON "thread_inbox_messages" USING btree ("thread_id") WHERE "thread_inbox_messages"."handed_back_by" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "threads_lineage_derivations" ON "threads" USING btree ("root_thread_id") WHERE "threads"."origin_type" IN ('fork', 'handoff');--> statement-breakpoint
CREATE INDEX "threads_deleted_by_work_idx" ON "threads" USING btree ("deleted_by_work_id") WHERE "threads"."deleted_by_work_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_blocks_turn_sequence" ON "turn_blocks" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "turn_blocks_turn_type" ON "turn_blocks" USING btree ("turn_id","block_type");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_position_unique" ON "turns" USING btree ("thread_id","position");--> statement-breakpoint
CREATE INDEX "turns_epoch_boundaries" ON "turns" USING btree ("thread_id","position") WHERE "turns"."prompt_bake_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "turns_unsettled" ON "turns" USING btree ("thread_id","position") WHERE "turns"."status" IN ('pending','streaming','awaiting_answer');--> statement-breakpoint
CREATE INDEX "turns_execution" ON "turns" USING btree ("thread_id","execution_id") WHERE "turns"."execution_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "turns_parent_position" ON "turns" USING btree ("parent_turn_id","position" DESC NULLS LAST) WHERE "turns"."parent_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "turns_pending_placeholders" ON "turns" USING btree ("id") WHERE "turns"."status" = 'pending' AND "turns"."role" IN ('compaction', 'system');--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_single_root" ON "turns" USING btree ("thread_id") WHERE "turns"."parent_turn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_stripe_session" ON "credit_lots" USING btree ("stripe_session_id") WHERE "credit_lots"."stripe_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_free_tier_grant" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'grant' AND "credit_lots"."grant_reason" LIKE 'free_tier_%';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_subscription_reason" ON "credit_lots" USING btree ("user_id","grant_reason") WHERE "credit_lots"."source_type" = 'subscription' AND "credit_lots"."grant_reason" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_lots_fifo_spend" ON "credit_lots" USING btree ("user_id","expires_at","created_at","id") WHERE "credit_lots"."remaining_millicredits" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_lots_debt_user" ON "credit_lots" USING btree ("user_id") WHERE "credit_lots"."source_type" = 'debt';--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created" ON "credit_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_transactions_consumption_group" ON "credit_transactions" USING btree ("consumption_group_id") WHERE "credit_transactions"."consumption_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branch_tree_changes_node" ON "branch_tree_changes" USING btree ("node_kind","node_id");--> statement-breakpoint
CREATE INDEX "branch_tree_changes_moved_folder" ON "branch_tree_changes" USING btree ("moved_folder_id") WHERE "branch_tree_changes"."moved_folder_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branch_tree_folders_folder" ON "branch_tree_folders" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "branch_tree_ranks_parent_rank" ON "branch_tree_ranks" USING btree ("branch_id","parent_kind","parent_id","rank" COLLATE "C","node_id");--> statement-breakpoint
CREATE INDEX "branches_active_origin_work" ON "branches" USING btree ("origin_work_id","created_at") WHERE "branches"."status" = 'active';--> statement-breakpoint
CREATE INDEX "branches_active_origin_lineage" ON "branches" USING btree ("project_id","origin_root_thread_id","created_at") WHERE "branches"."status" = 'active' AND "branches"."origin_root_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "branches_project" ON "branches" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "context_sources_deleted_by_work_idx" ON "context_sources" USING btree ("deleted_by_work_id") WHERE "context_sources"."deleted_by_work_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_project_scope_slug" ON "context_sources" USING btree ("project_id","slug") WHERE "context_sources"."work_id" IS NULL AND "context_sources"."root_thread_id" IS NULL AND "context_sources"."chat_thread_id" IS NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_work_slug" ON "context_sources" USING btree ("work_id","slug") WHERE "context_sources"."work_id" IS NOT NULL AND "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_lineage_slug" ON "context_sources" USING btree ("root_thread_id","slug") WHERE "context_sources"."root_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_chat_slug" ON "context_sources" USING btree ("chat_thread_id","slug") WHERE "context_sources"."chat_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "context_sources_project_sort" ON "context_sources" USING btree ("project_id","sort_order") WHERE "context_sources"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_forwards_to" ON "document_forwards" USING btree ("to_document_id");--> statement-breakpoint
CREATE INDEX "document_links_target_document" ON "document_links" USING btree ("target_document_id");--> statement-breakpoint
CREATE INDEX "document_links_ahead" ON "document_links" USING btree ("ahead_id");--> statement-breakpoint
CREATE INDEX "document_previous_locations_path" ON "document_previous_locations" USING hash ("path");--> statement-breakpoint
CREATE INDEX "document_previous_locations_source" ON "document_previous_locations" USING btree ("context_source_id");--> statement-breakpoint
CREATE INDEX "document_previous_locations_document" ON "document_previous_locations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_purge_candidates" ON "documents" USING btree ("deleted_at","id") WHERE "documents"."content_purged_at" IS NULL AND "documents"."deleted_at" IS NOT NULL AND "documents"."deletion_reason" = 'deleted' AND NOT "documents"."hidden" AND "documents"."deleted_by_work_id" IS NULL;--> statement-breakpoint
CREATE INDEX "documents_deleted_by_work_idx" ON "documents" USING btree ("deleted_by_work_id") WHERE "documents"."deleted_by_work_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_deleted_by_thread_idx" ON "documents" USING btree ("deleted_by_thread_id") WHERE "documents"."deleted_by_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_context_location" ON "documents" USING btree ("context_source_id","folder_id","name","extension");--> statement-breakpoint
CREATE INDEX "documents_sibling_rank_live" ON "documents" USING btree ("context_source_id","folder_id","rank" COLLATE "C","id") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden" AND "documents"."rank" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_folder_name_live" ON "documents" USING btree ("context_source_id","folder_id","name","extension") WHERE "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";--> statement-breakpoint
CREATE UNIQUE INDEX "documents_context_root_name_live" ON "documents" USING btree ("context_source_id","name","extension") WHERE "documents"."folder_id" IS NULL AND "documents"."deleted_at" IS NULL AND NOT "documents"."hidden";--> statement-breakpoint
CREATE INDEX "documents_context_all_images" ON "documents" USING btree ("context_source_id") WHERE "documents"."file_type" = 'image';--> statement-breakpoint
CREATE INDEX "documents_name_fts" ON "documents" USING gin (to_tsvector('simple', "name"));--> statement-breakpoint
CREATE INDEX "documents_name_trgm" ON "documents" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "folders_deleted_by_work_idx" ON "folders" USING btree ("deleted_by_work_id") WHERE "folders"."deleted_by_work_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folders_context_parent_active" ON "folders" USING btree ("context_source_id","parent_id") WHERE "folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "folders_sibling_rank_live" ON "folders" USING btree ("context_source_id","parent_id","rank" COLLATE "C","id") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden" AND "folders"."rank" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_parent_name_live" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE UNIQUE INDEX "folders_context_root_name_live" ON "folders" USING btree ("context_source_id","name") WHERE "folders"."parent_id" IS NULL AND "folders"."deleted_at" IS NULL AND NOT "folders"."hidden";--> statement-breakpoint
CREATE INDEX "folders_nonlive_location" ON "folders" USING btree ("context_source_id","parent_id","name") WHERE ("folders"."hidden" AND "folders"."deleted_at" IS NULL) OR (NOT "folders"."hidden" AND "folders"."deleted_at" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "folders_context_root" ON "folders" USING btree ("context_source_id") WHERE "folders"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "folders_parent" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "link_ahead_refs_owner_unsettled" ON "link_ahead_refs" USING btree ("project_id","scheme","work_id","root_thread_id","chat_thread_id",md5("path")) WHERE "link_ahead_refs"."settled_document_id" IS NULL;--> statement-breakpoint
CREATE INDEX "link_ahead_refs_settled_document" ON "link_ahead_refs" USING btree ("settled_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_slug" ON "projects" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "projects_user_last_activity_active" ON "projects" USING btree ("user_id","last_activity_at" DESC NULLS LAST) WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_personal" ON "projects" USING btree ("user_id") WHERE "projects"."is_personal" = true AND "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "upload_intakes_owner_thread" ON "upload_intakes" USING btree ("owner_thread_id") WHERE "upload_intakes"."owner_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "upload_intakes_open_updated" ON "upload_intakes" USING btree ("updated_at") WHERE "upload_intakes"."state" IN ('reserved', 'object_stored');--> statement-breakpoint
CREATE INDEX "works_project_updated_active" ON "works" USING btree ("project_id","updated_at" DESC NULLS LAST) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "works_created_by_active" ON "works" USING btree ("created_by_user_id") WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_name_active" ON "works" USING btree ("project_id",lower("name")) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_handle" ON "works" USING btree ("project_id","handle") WHERE "works"."handle" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_no_work_active" ON "works" USING btree ("project_id") WHERE "works"."is_no_work" = true AND "works"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_catalog_commits_scope_revision_uq" ON "context_catalog_commits" USING btree ("scope_key","first_revision");--> statement-breakpoint
CREATE INDEX "context_catalog_commits_commit_idx" ON "context_catalog_commits" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "context_catalog_entries_parent_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'parentId'));--> statement-breakpoint
CREATE INDEX "context_catalog_entries_uri_idx" ON "context_catalog_entries" USING btree ("scope_key",("entry"->>'uri'));--> statement-breakpoint
CREATE INDEX "context_staged_documents_project_idx" ON "context_staged_documents" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "context_staged_folders_project_idx" ON "context_staged_folders" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_edit_parts_edit_ordinal" ON "document_edit_parts" USING btree ("edit_id","ordinal");--> statement-breakpoint
CREATE INDEX "document_edit_parts_pending_origin_idx" ON "document_edit_parts" USING btree (("origin"->>'draftId')) WHERE "document_edit_parts"."origin"->>'kind' = 'pending';--> statement-breakpoint
CREATE INDEX "document_edit_parts_live_origin_seq" ON "document_edit_parts" USING btree ((("origin"->>'seq')::bigint)) WHERE "document_edit_parts"."origin"->>'kind' = 'live';--> statement-breakpoint
CREATE INDEX "document_edits_document_idx" ON "document_edits" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_edits_turn_idx" ON "document_edits" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "document_edits_action_idx" ON "document_edits" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "import_entries_import_order" ON "import_entries" USING btree ("import_id","ordinal");--> statement-breakpoint
CREATE INDEX "import_entries_import_state" ON "import_entries" USING btree ("import_id","state");--> statement-breakpoint
CREATE INDEX "imports_project_created" ON "imports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "imports_user_open" ON "imports" USING btree ("user_id") WHERE "imports"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "imports_organize_claim" ON "imports" USING btree ("state","lease_until") WHERE "imports"."state" = 'organizing';--> statement-breakpoint
CREATE INDEX "imports_upload_expiry" ON "imports" USING btree ("last_activity_at") WHERE "imports"."state" = 'uploading';--> statement-breakpoint
CREATE INDEX "user_recent_documents_user_opened_idx" ON "user_recent_documents" USING btree ("user_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_project_created_idx" ON "project_results" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_root_thread_idx" ON "project_results" USING btree ("root_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_results_deleted_by_work_idx" ON "project_results" USING btree ("deleted_by_work_id") WHERE "project_results"."deleted_by_work_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "asks_open_deadline" ON "asks" USING btree ("deadline_at","id") WHERE "asks"."status" = 'open' AND "asks"."deadline_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "asks_thread_created" ON "asks" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "asks_held_by_thread" ON "asks" USING btree ("thread_id") WHERE "asks"."status" IN ('pending', 'open') OR "asks"."continuation" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "asks_one_live_per_thread" ON "asks" USING btree ("thread_id") WHERE "asks"."status" IN ('pending', 'open');--> statement-breakpoint
CREATE UNIQUE INDEX "apply_command_effects_group" ON "apply_command_effects" USING btree ("command_id","group_id");--> statement-breakpoint
CREATE INDEX "collab_staged_states_project_idx" ON "collab_staged_states" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_block_rooms_document" ON "document_block_rooms" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_drafts_active_branch_document" ON "document_drafts" USING btree ("document_id","branch_id") WHERE "document_drafts"."kind" = 'work_draft' AND "document_drafts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_drafts_active_work_draft_by_branch" ON "document_drafts" USING btree ("branch_id","id") WHERE "document_drafts"."kind" = 'work_draft' AND "document_drafts"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "document_drafts_active_thread_peer" ON "document_drafts" USING btree ("document_id","thread_id") WHERE "document_drafts"."kind" = 'thread_peer' AND "document_drafts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_yjs_checkpoints_document_id_desc" ON "document_yjs_checkpoints" USING btree ("document_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_checkpoints_initial" ON "document_yjs_checkpoints" USING btree ("document_id") WHERE "document_yjs_checkpoints"."up_to_seq" = 0;--> statement-breakpoint
CREATE INDEX "document_yjs_updates_document_id" ON "document_yjs_updates" USING btree ("document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_updates_authority_admission" ON "document_yjs_updates" USING btree ("authority_id","authority_generation","admission_sequence","batch_ordinal");--> statement-breakpoint
CREATE INDEX "draft_write_journal_draft" ON "draft_write_journal" USING btree ("draft_id","id");--> statement-breakpoint
CREATE INDEX "draft_write_journal_thread_turn" ON "draft_write_journal" USING btree ("draft_id","thread_id","turn_id");--> statement-breakpoint
CREATE INDEX "draft_write_journal_active" ON "draft_write_journal" USING btree ("draft_id","status") WHERE "draft_write_journal"."status" = 'active';--> statement-breakpoint
CREATE INDEX "pending_notices_thread" ON "pending_notices" USING btree ("thread_id","created_at","id");
--> statement-breakpoint
-- Capture only generation-qualified checkpoint and journal references. The
-- exception block releases its own mutation lock without rolling back sibling
-- statements or retaining capture-acquired locks in an ambient transaction.
CREATE OR REPLACE FUNCTION capture_document_checkpoint_range(
  p_document_id text,
  p_authority_id uuid,
  p_generation bigint
)
RETURNS TABLE (base_id bigint, floor_seq bigint, ceiling_seq bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matches boolean := false;
  v_base_id bigint;
  v_floor bigint;
  v_ceiling bigint;
BEGIN
  BEGIN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('document-mutation:' || p_document_id, 0::bigint)
    );
    SELECT EXISTS (
      SELECT 1 FROM document_yjs_heads h
      WHERE h.document_id = p_document_id::uuid
        AND h.authority_id = p_authority_id
        AND h.authority_generation = p_generation
    ) INTO v_matches;
    IF v_matches THEN
      SELECT c.id, c.up_to_seq INTO v_base_id, v_floor
      FROM document_yjs_checkpoints c
      WHERE c.document_id = p_document_id::uuid
        AND c.authority_id = p_authority_id
        AND c.authority_generation = p_generation
      ORDER BY c.up_to_seq DESC, c.id DESC
      LIMIT 1;
      v_floor := coalesce(v_floor, 0);
      -- Admissions allocate IDs under the mutation lock. The generation's
      -- admission index avoids scanning retained rows of retired generations.
      SELECT u.id INTO v_ceiling FROM document_yjs_updates u
      WHERE u.document_id = p_document_id::uuid
        AND u.authority_id = p_authority_id
        AND u.authority_generation = p_generation
      ORDER BY u.admission_sequence DESC, u.batch_ordinal DESC
      LIMIT 1;
      v_ceiling := greatest(v_floor, coalesce(v_ceiling, 0));
    END IF;
    -- PL/pgSQL variables survive this subtransaction rollback; locks do not.
    RAISE EXCEPTION USING ERRCODE = 'MFC01', MESSAGE = 'release checkpoint snapshot lock';
  EXCEPTION WHEN SQLSTATE 'MFC01' THEN
    NULL;
  END;
  IF v_matches THEN
    RETURN QUERY SELECT v_base_id, v_floor, v_ceiling;
  END IF;
END;
$$;
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
  went_negative BOOLEAN,
  consumption_group_id UUID
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
  v_consumption_group_id UUID;
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

  -- Replay idempotency is scoped per (user_id, usage_event_id) to match the
  -- per-user advisory lock above and the CreditLedger port contract. A single
  -- debit may write several consumption rows (one per consumed lot) sharing this
  -- usage_event_id, so this is an existence fence, NOT a unique index.
  IF EXISTS (
    SELECT 1
    FROM credit_transactions
    WHERE user_id = p_user_id
      AND usage_event_id = p_usage_event_id
      AND transaction_type = 'consumption'
  ) THEN
    SELECT ct.consumption_group_id
    INTO v_consumption_group_id
    FROM credit_transactions ct
    WHERE ct.user_id = p_user_id
      AND ct.usage_event_id = p_usage_event_id
      AND ct.transaction_type = 'consumption'
    LIMIT 1;

    SELECT COALESCE(SUM(remaining_millicredits), 0)
    INTO v_balance
    FROM credit_lots
    WHERE user_id = p_user_id
      AND (expires_at IS NULL OR expires_at > NOW() OR source_type = 'debt');

    RETURN QUERY SELECT
      COALESCE(v_balance, 0),
      COALESCE(v_balance, 0) < 0,
      v_consumption_group_id;
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

  SELECT COALESCE(SUM(remaining_millicredits), 0)
  INTO v_balance
  FROM credit_lots
  WHERE user_id = p_user_id
    AND (expires_at IS NULL OR expires_at > NOW() OR source_type = 'debt');

  RETURN QUERY SELECT
    COALESCE(v_balance, 0),
    COALESCE(v_balance, 0) < 0,
    p_consumption_group_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.enforce_prompt_bake_insert_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM threads WHERE id = OLD.owner_thread_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Prompt bakes are insert-only'
    USING ERRCODE = '23514', CONSTRAINT = 'prompt_bakes_insert_only';
END;
$$;

CREATE FUNCTION public.enforce_prompt_bake_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_value jsonb;
  new_value jsonb;
BEGIN
  old_value := to_jsonb(OLD) -> TG_ARGV[0];
  new_value := to_jsonb(NEW) -> TG_ARGV[0];
  IF old_value IS DISTINCT FROM 'null'::jsonb AND new_value IS DISTINCT FROM old_value THEN
    RAISE EXCEPTION 'Prompt bake pointer is write-once'
      USING ERRCODE = '23514', CONSTRAINT = TG_ARGV[1];
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_turn_position_write_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'Turn position is write-once'
      USING ERRCODE = '23514', CONSTRAINT = 'turns_position_write_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity(p_thread_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
          tr.forgotten_by_turn_id, 0 AS depth
        FROM turns tr WHERE tr.id = t.active_leaf_turn_id
        UNION ALL
        SELECT parent.id, parent.parent_turn_id, parent.role, parent.metadata,
          parent.created_at, parent.completed_at, parent.forgotten_by_turn_id, l.depth + 1
        FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
        -- Every assistant is visible; this also caps malformed/cyclic lineage.
        -- A forgotten assistant is walked through, not stopped at: it is no longer a visible head.
        WHERE (l.role <> 'assistant' OR l.forgotten_by_turn_id IS NOT NULL) AND l.depth < 10000
      )
      SELECT l.id AS turn_id, COALESCE(l.completed_at, l.created_at) AS activity_at
      FROM lineage l
      WHERE l.forgotten_by_turn_id IS NULL AND NOT EXISTS (
        -- A handed-back writer message left the chat: it never anchors the head or its preview.
        SELECT 1 FROM thread_inbox_messages handed_back
        WHERE handed_back.id = l.id AND handed_back.handed_back_by IS NOT NULL
      ) AND (
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_block_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_block_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.recompute_thread_chat_activity_from_forget() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_hand_back() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.recompute_thread_chat_activity_from_turn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_thread_chat_activity(NEW.thread_id);
  RETURN NULL;
END;
$$;

ALTER TABLE public.document_block_rooms SET (fillfactor = 90);

CREATE TRIGGER prompt_bakes_insert_only BEFORE DELETE OR UPDATE ON public.prompt_bakes FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_insert_only();

CREATE TRIGGER recompute_thread_chat_activity_on_active_leaf AFTER UPDATE OF active_leaf_turn_id ON public.threads FOR EACH ROW WHEN ((new.active_leaf_turn_id IS DISTINCT FROM old.active_leaf_turn_id)) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_thread();

CREATE TRIGGER recompute_thread_chat_activity_on_block_insert AFTER INSERT ON public.turn_blocks FOR EACH ROW WHEN ((new.block_type = 'custom'::text)) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_block_insert();

CREATE TRIGGER recompute_thread_chat_activity_on_block_update AFTER UPDATE OF block_type, turn_id ON public.turn_blocks FOR EACH ROW WHEN (((new.block_type = 'custom'::text) OR (old.block_type = 'custom'::text))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_block_update();

CREATE TRIGGER recompute_thread_chat_activity_on_forget AFTER UPDATE OF forgotten_by_turn_id ON public.turns FOR EACH ROW WHEN (((new.forgotten_by_turn_id IS NOT NULL) AND (old.forgotten_by_turn_id IS NULL))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_forget();

CREATE TRIGGER recompute_thread_chat_activity_on_hand_back AFTER UPDATE OF handed_back_by ON public.thread_inbox_messages FOR EACH ROW WHEN (((new.handed_back_by IS NOT NULL) AND (old.handed_back_by IS NULL))) EXECUTE FUNCTION public.recompute_thread_chat_activity_from_hand_back();

CREATE TRIGGER recompute_thread_chat_activity_on_turn AFTER INSERT OR UPDATE OF role, metadata, status, completed_at ON public.turns FOR EACH ROW EXECUTE FUNCTION public.recompute_thread_chat_activity_from_turn();

CREATE TRIGGER threads_initial_prompt_bake_write_once BEFORE UPDATE OF initial_prompt_bake_id ON public.threads FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_write_once('initial_prompt_bake_id', 'threads_initial_prompt_bake_write_once');

CREATE TRIGGER turns_position_write_once BEFORE UPDATE OF "position" ON public.turns FOR EACH ROW EXECUTE FUNCTION public.enforce_turn_position_write_once();

CREATE TRIGGER turns_prompt_bake_write_once BEFORE UPDATE OF prompt_bake_id ON public.turns FOR EACH ROW EXECUTE FUNCTION public.enforce_prompt_bake_write_once('prompt_bake_id', 'turns_prompt_bake_write_once');

ALTER TABLE ONLY public.threads
    ALTER CONSTRAINT threads_initial_prompt_bake_id_prompt_bakes_id_fk DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.threads
    ALTER CONSTRAINT threads_origin_turn_id_turns_id_fk DEFERRABLE;

ALTER TABLE ONLY public.turns
    ALTER CONSTRAINT turns_prompt_bake_id_prompt_bakes_id_fk DEFERRABLE INITIALLY DEFERRED;
