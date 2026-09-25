import type {
  DocumentId,
  EventJournalId,
  ModelResponseId,
  ProjectId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import type { JsonValue, PriceSource } from "@meridian/contracts/threads";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, softDeleteAt, updatedAt } from "./_shared";
import { documents, projects, works } from "./content";
import { users } from "./users";

export const threads = pgTable(
  "threads",
  {
    id: idColumn<ThreadId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    ref: text("ref"),
    kind: text("kind").notNull().default("primary"),
    status: text("status").notNull().default("idle"),
    workingState: jsonb("working_state"),
    composedSystemPrompt: text("composed_system_prompt"),
    bakedSkillSlugs: jsonb("baked_skill_slugs").$type<string[] | null>(),
    systemPromptHash: text("system_prompt_hash"),
    parentThreadId: uuid("parent_thread_id").$type<ThreadId>(),
    rootThreadId: uuid("root_thread_id").$type<ThreadId>(),
    originTurnId: uuid("origin_turn_id").$type<TurnId>(),
    originType: text("origin_type"),
    spawnStatus: text("spawn_status"),
    spawnDepth: integer("spawn_depth").notNull().default(0),
    activeLeafTurnId: uuid("active_leaf_turn_id").$type<TurnId>(),
    turnCount: integer("turn_count").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    nextSeq: bigint("next_seq", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    unique("threads_project_id_unique").on(table.projectId, table.id),
    uniqueIndex("threads_project_ref")
      .on(table.projectId, table.ref)
      .where(sql`${table.ref} IS NOT NULL`),
    index("threads_project_updated_active")
      .on(table.projectId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    index("threads_created_by_active")
      .on(table.createdByUserId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("threads_parent_created_active")
      .on(table.parentThreadId, table.createdAt.desc())
      .where(sql`${table.parentThreadId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    foreignKey({
      columns: [table.projectId, table.rootThreadId],
      foreignColumns: [table.projectId, table.id],
      name: "threads_spawn_root_same_project_fk",
    }).onDelete("cascade"),
    check(
      "threads_spawn_root_required",
      sql`${table.kind} != 'subagent' OR ${table.rootThreadId} IS NOT NULL`,
    ),
    check("threads_no_self_parent", sql`${table.id} != ${table.parentThreadId}`),
    check("threads_spawn_depth_nonneg", sql`${table.spawnDepth} >= 0`),
    check("threads_next_seq_nonneg", sql`${table.nextSeq} >= 0`),
    check("threads_kind_valid", sql`${table.kind} IN ('primary', 'subagent')`),
    // Lifecycle only. Run state is derived from the lease, never stored here.
    check("threads_status_valid", sql`${table.status} IN ('idle', 'archived')`),
    check(
      "threads_origin_type_valid",
      sql`${table.originType} IS NULL OR ${table.originType} IN ('spawn', 'handoff', 'fork')`,
    ),
    check(
      "threads_spawn_origin_subagent",
      sql`${table.originType} != 'spawn' OR ${table.kind} = 'subagent'`,
    ),
    check(
      "threads_spawn_origin_required_fields",
      sql`${table.originType} != 'spawn' OR (${table.kind} = 'subagent' AND ${table.parentThreadId} IS NOT NULL AND ${table.originTurnId} IS NOT NULL AND ${table.spawnStatus} IS NOT NULL)`,
    ),
    check(
      "threads_handoff_fork_primary",
      sql`${table.originType} NOT IN ('handoff', 'fork') OR ${table.kind} = 'primary'`,
    ),
    check(
      "threads_fork_origin_required_fields",
      sql`${table.originType} != 'fork' OR (${table.kind} = 'primary' AND ${table.parentThreadId} IS NOT NULL AND ${table.originTurnId} IS NOT NULL)`,
    ),
    check(
      "threads_handoff_origin_required_fields",
      sql`${table.originType} != 'handoff' OR (${table.kind} = 'primary' AND ${table.parentThreadId} IS NOT NULL)`,
    ),
    check(
      "threads_organic_origin_fields_empty",
      sql`${table.originType} IS NOT NULL OR (${table.parentThreadId} IS NULL AND ${table.originTurnId} IS NULL AND ${table.spawnStatus} IS NULL)`,
    ),
    check(
      "threads_spawn_status_subagent",
      sql`${table.spawnStatus} IS NULL OR ${table.kind} = 'subagent'`,
    ),
    check(
      "threads_spawn_status_valid",
      sql`${table.spawnStatus} IS NULL OR ${table.spawnStatus} IN ('running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const projectThreadCounters = pgTable("project_thread_counters", {
  projectId: uuid("project_id")
    .$type<ProjectId>()
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  n: integer("n").notNull(),
});

/** M:N thread↔Work history; every live thread has one primary row. */
export const threadWorks = pgTable(
  "thread_works",
  {
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    workId: uuid("work_id").$type<WorkId>().notNull(),
    projectId: uuid("project_id").$type<ProjectId>().notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.workId], name: "thread_works_pk" }),
    foreignKey({
      columns: [table.projectId, table.threadId],
      foreignColumns: [threads.projectId, threads.id],
      name: "thread_works_project_thread_same_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.workId],
      foreignColumns: [works.projectId, works.id],
      name: "thread_works_project_work_same_project_fk",
    }).onDelete("restrict"),
    index("thread_works_thread_idx").on(table.threadId),
    index("thread_works_work_idx").on(table.workId),
    uniqueIndex("thread_works_primary_unique")
      .on(table.threadId)
      .where(sql`${table.isPrimary} = true`),
  ],
);

/** Coalesced durable requests to refresh a frozen thread's model-visible Work context. */
export const workContextDeliveryObligations = pgTable("work_context_delivery_obligations", {
  threadId: uuid("thread_id")
    .$type<ThreadId>()
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Durable per-thread message queue drained in a batch at the next delivery
 * boundary. Rows are marked delivered rather than deleted so the idempotency
 * key and replay facts survive. `seq` is a global bigserial; sequences order
 * allocation, not commit, so FIFO within a thread rests on the domain `enqueue`
 * serializing per thread (it holds the per-thread lock): with commits serialized,
 * `seq` orders them within the thread without a per-thread counter row.
 */
export const threadInboxMessages = pgTable(
  "thread_inbox_messages",
  {
    id: idColumn<string>(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    intent: text("intent").notNull(),
    provenance: jsonb("provenance").$type<JsonValue>().notNull(),
    body: jsonb("body").$type<JsonValue>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    unique("thread_inbox_messages_idem_unique").on(table.threadId, table.idempotencyKey),
    index("thread_inbox_messages_pending")
      .on(table.threadId, table.seq)
      .where(sql`${table.deliveredAt} IS NULL`),
    check("thread_inbox_messages_intent_valid", sql`${table.intent} IN ('message','notice')`),
    check(
      "thread_inbox_messages_provenance_valid",
      sql`(${table.provenance}->>'kind' IN ('writer','agent','child','system')) IS TRUE`,
    ),
    check(
      "thread_inbox_messages_body_valid",
      sql`(${table.body}->>'kind' IN ('text','report','context')) IS TRUE`,
    ),
  ],
);

/**
 * Queryable run lease paired with the cross-process advisory lock. The lock is
 * the atomic mutex (crash-safe because the DB session dies); this expiring row
 * is what `holder()`, derived status, and the running-turn read can observe from
 * another process. `turnId` is bound after the run's assistant turn commits, so
 * it may be null while a run is mid-setup.
 */
export const threadRunLeases = pgTable(
  "thread_run_leases",
  {
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    turnId: uuid("turn_id").$type<TurnId>(),
    holderId: text("holder_id").notNull(),
    phase: text("phase").notNull().default("generating"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("thread_run_leases_phase_valid", sql`${table.phase} IN ('generating','waiting')`),
    index("thread_run_leases_expiry").on(table.expiresAt),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: idColumn<TurnId>(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    parentTurnId: uuid("parent_turn_id").$type<TurnId>(),
    compactionModel: text("compaction_model"),
    role: text("role").notNull(),
    aiWriteMode: text("ai_write_mode"),
    status: text("status").notNull().default("pending"),
    finishReason: text("finish_reason"),
    error: text("error"),
    model: text("model"),
    provider: text("provider"),
    totalInputTokens: integer("total_input_tokens").default(0),
    totalOutputTokens: integer("total_output_tokens").default(0),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }).default("0"),
    totalMillicredits: bigint("total_millicredits", { mode: "number" }),
    responseCount: integer("response_count").notNull().default(0),
    requestParams: jsonb("request_params"),
    responseMetadata: jsonb("response_metadata"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("turns_thread_id_id_unique").on(table.threadId, table.id),
    index("turns_thread_created").on(table.threadId, table.createdAt.desc()),
    index("turns_parent_created")
      .on(table.parentTurnId, table.createdAt.desc())
      .where(sql`${table.parentTurnId} IS NOT NULL`),
    uniqueIndex("turns_thread_single_root")
      .on(table.threadId)
      .where(sql`${table.parentTurnId} IS NULL`),
    check(
      "turns_no_self_parent",
      sql`${table.parentTurnId} IS NULL OR ${table.parentTurnId} != ${table.id}`,
    ),
    check("turns_role_valid", sql`${table.role} IN ('user', 'assistant', 'system', 'compaction')`),
    check(
      "turns_ai_write_mode_valid",
      sql`${table.aiWriteMode} IS NULL OR ${table.aiWriteMode} IN ('direct', 'draft')`,
    ),
    check(
      "turns_status_valid",
      sql`${table.status} IN ('pending', 'streaming', 'waiting_interrupt', 'complete', 'cancelled', 'error')`,
    ),
    check(
      "turns_compaction_model_required",
      sql`${table.role} != 'compaction' OR ${table.compactionModel} IS NOT NULL`,
    ),
  ],
);

export const modelResponses = pgTable(
  "model_responses",
  {
    id: idColumn<ModelResponseId>(),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    priceSource: text("price_source").$type<PriceSource>().notNull().default("computed"),
    pricingSnapshot: jsonb("pricing_snapshot"),
    inputTokens: integer("input_tokens").default(0),
    outputTokens: integer("output_tokens").default(0),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    usageBreakdown: jsonb("usage_breakdown").default(sql`'{}'::jsonb`),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    millicredits: bigint("millicredits", { mode: "number" }),
    stopReason: text("stop_reason"),
    requestParams: jsonb("request_params"),
    responseMetadata: jsonb("response_metadata"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("model_responses_turn_sequence").on(table.turnId, table.sequence),
    index("model_responses_provider_model_created").on(
      table.provider,
      table.model,
      table.createdAt,
    ),
    check(
      "model_responses_price_source_valid",
      sql`${table.priceSource} IN ('computed', 'provider_reported', 'configured_rate', 'unknown')`,
    ),
  ],
);

export const turnBlocks = pgTable(
  "turn_blocks",
  {
    id: idColumn<TurnBlockId>(),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    modelResponseId: uuid("model_response_id")
      .$type<ModelResponseId>()
      .references(() => modelResponses.id, {
        onDelete: "set null",
      }),
    blockType: text("block_type").notNull(),
    status: text("status").notNull().default("complete"),
    sequence: integer("sequence").notNull(),
    provider: text("provider"),
    providerData: jsonb("provider_data"),
    modelText: text("model_text"),
    content: jsonb("content"),
    compact: text("compact"),
    pruned: boolean("pruned").notNull().default(false),
    executionSide: text("execution_side"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("turn_blocks_turn_sequence").on(table.turnId, table.sequence),
    index("turn_blocks_turn_type").on(table.turnId, table.blockType),
    check("turn_blocks_status_valid", sql`${table.status} IN ('complete', 'partial')`),
    check(
      "turn_blocks_block_type_valid",
      sql`${table.blockType} IN ('text', 'image', 'file', 'thinking', 'reasoning', 'tool_use', 'tool_result', 'custom')`,
    ),
  ],
);

export const threadExecutionReports = pgTable(
  "thread_execution_reports",
  {
    assistantTurnId: uuid("assistant_turn_id")
      .$type<TurnId>()
      .primaryKey()
      .references(() => turns.id, { onDelete: "cascade" }),
    childThreadId: uuid("child_thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    origin: text("origin").notNull(),
    deliveryMode: text("delivery_mode").notNull(),
    callerThreadId: uuid("caller_thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    callerTurnId: uuid("caller_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    toolCallId: text("tool_call_id"),
    cardBlockId: uuid("card_block_id")
      .$type<TurnBlockId>()
      .references(() => turnBlocks.id, { onDelete: "set null" }),
    agentSlug: text("agent_slug"),
    description: text("description"),
    capture: jsonb("capture").$type<JsonValue | null>(),
    captureToolCallId: text("capture_tool_call_id"),
    outcome: text("outcome"),
    reason: text("reason"),
    source: text("source"),
    summary: text("summary"),
    payload: jsonb("payload").$type<JsonValue | null>(),
    artifacts: jsonb("artifacts").$type<JsonValue | null>(),
    costMillicredits: bigint("cost_millicredits", { mode: "number" }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    publication: text("publication").notNull().default("none"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.childThreadId, table.assistantTurnId],
      foreignColumns: [turns.threadId, turns.id],
      name: "thread_execution_reports_child_turn_fk",
    }).onDelete("cascade"),
    index("thread_execution_reports_pending")
      .on(table.assistantTurnId)
      .where(sql`${table.publication} = 'pending'`),
    check(
      "thread_execution_reports_origin_valid",
      sql`${table.origin} IN ('spawn','foreground_message','thread_run')`,
    ),
    check(
      "thread_execution_reports_delivery_valid",
      sql`${table.deliveryMode} IN ('background_notification','direct','none')`,
    ),
    check(
      "thread_execution_reports_origin_delivery_valid",
      sql`(${table.origin} = 'spawn' AND ${table.deliveryMode} IN ('background_notification','direct')) OR (${table.origin} = 'foreground_message' AND ${table.deliveryMode} = 'direct') OR (${table.origin} = 'thread_run' AND ${table.deliveryMode} = 'none')`,
    ),
    check(
      "thread_execution_reports_capture_call_coherent",
      sql`(${table.capture} IS NULL AND ${table.captureToolCallId} IS NULL) OR (${table.capture} IS NOT NULL AND ${table.captureToolCallId} IS NOT NULL)`,
    ),
    check(
      "thread_execution_reports_outcome_valid",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded','failed','cancelled')`,
    ),
    check(
      "thread_execution_reports_source_valid",
      sql`${table.source} IS NULL OR ${table.source} IN ('return_result','final_assistant','empty')`,
    ),
    check(
      "thread_execution_reports_publication_valid",
      sql`${table.publication} IN ('none','pending','published','skipped')`,
    ),
    check(
      "thread_execution_reports_terminal_coherent",
      sql`(${table.outcome} IS NULL AND ${table.terminalAt} IS NULL) OR (${table.outcome} IS NOT NULL AND ${table.source} IS NOT NULL AND ${table.summary} IS NOT NULL AND ${table.terminalAt} IS NOT NULL)`,
    ),
    check(
      "thread_execution_reports_publication_timestamp_coherent",
      sql`(${table.publication} IN ('none','pending') AND ${table.publishedAt} IS NULL) OR (${table.publication} IN ('published','skipped') AND ${table.publishedAt} IS NOT NULL)`,
    ),
  ],
);

export const eventJournal = pgTable(
  "event_journal",
  {
    id: idColumn<EventJournalId>(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "restrict" }),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonbDefault("payload"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("event_journal_thread_seq_unique").on(table.threadId, table.seq),
    uniqueIndex("event_journal_event_id_unique")
      .on(sql`(${table.payload}->>'eventId')`)
      .where(sql`${table.payload}->>'eventId' IS NOT NULL`),
    index("event_journal_thread_seq").on(table.threadId, table.seq),
    index("event_journal_turn_id")
      .on(table.turnId, table.createdAt)
      .where(sql`${table.turnId} IS NOT NULL`),
  ],
);

export const threadUserState = pgTable(
  "thread_user_state",
  {
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isFavorite: boolean("is_favorite").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.userId] })],
);

export const threadDocuments = pgTable(
  "thread_documents",
  {
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull().default("editing"),
    firstTouchedAt: timestamp("first_touched_at", { withTimezone: true }).notNull().defaultNow(),
    lastTouchedAt: timestamp("last_touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.documentId] }),
    check(
      "thread_documents_relationship_valid",
      sql`${table.relationship} IN ('editing', 'reading', 'created')`,
    ),
  ],
);

export const userTurnAdmissions = pgTable(
  "user_turn_admissions",
  {
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    submissionId: text("submission_id").notNull(),
    actorUserId: uuid("actor_user_id").$type<UserId>().notNull(),
    fingerprint: text("fingerprint"),
    state: text("state").notNull(),
    rejectionCode: text("rejection_code"),
    userTurnId: uuid("user_turn_id").$type<TurnId>(),
    assistantTurnId: uuid("assistant_turn_id").$type<TurnId>(),
    resumeAfterSeq: text("resume_after_seq"),
    snapshotFloorNextSeq: text("snapshot_floor_next_seq"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.submissionId] }),
    check(
      "user_turn_admissions_state_valid",
      sql`${table.state} IN ('pending', 'accepted', 'rejected', 'retired')`,
    ),
  ],
);

// Deferred FKs in migration SQL: threads.parent_thread_id, threads.origin_turn_id,
// threads.active_leaf_turn_id, turns.parent_turn_id.
