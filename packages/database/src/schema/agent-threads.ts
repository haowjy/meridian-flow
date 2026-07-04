import type {
  AgentDefinitionId,
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
import type { PriceSource } from "@meridian/contracts/threads";
import { sql } from "drizzle-orm";
import {
  bigint,
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
import { agentDefinitions } from "./agent-packages";
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
    kind: text("kind").notNull().default("primary"),
    status: text("status").notNull().default("idle"),
    currentAgentId: text("current_agent_id"),
    workingState: jsonb("working_state"),
    composedSystemPrompt: text("composed_system_prompt"),
    bakedSkillSlugs: jsonb("baked_skill_slugs").$type<string[] | null>(),
    systemPromptHash: text("system_prompt_hash"),
    parentThreadId: uuid("parent_thread_id").$type<ThreadId>(),
    originTurnId: uuid("origin_turn_id").$type<TurnId>(),
    originType: text("origin_type"),
    spawnStatus: text("spawn_status"),
    spawnResult: jsonb("spawn_result"),
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
    index("threads_project_updated_active")
      .on(table.projectId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    index("threads_created_by_active")
      .on(table.createdByUserId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("threads_parent_created_active")
      .on(table.parentThreadId, table.createdAt.desc())
      .where(sql`${table.parentThreadId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    check("threads_no_self_parent", sql`${table.id} != ${table.parentThreadId}`),
    check("threads_spawn_depth_nonneg", sql`${table.spawnDepth} >= 0`),
    check("threads_next_seq_nonneg", sql`${table.nextSeq} >= 0`),
    check("threads_kind_valid", sql`${table.kind} IN ('primary', 'subagent')`),
    check(
      "threads_status_valid",
      sql`${table.status} IN ('idle', 'active', 'blocked', 'error', 'archived')`,
    ),
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

/** M:N thread↔work membership; primary Work is the default work-scoped authority. */
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

export const turns = pgTable(
  "turns",
  {
    id: idColumn<TurnId>(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    parentTurnId: uuid("parent_turn_id").$type<TurnId>(),
    agentDefinitionId: uuid("agent_definition_id")
      .$type<AgentDefinitionId>()
      .references(() => agentDefinitions.id, {
        onDelete: "set null",
      }),
    compactionModel: text("compaction_model"),
    role: text("role").notNull(),
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
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
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
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
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

// Deferred FKs in migration SQL: threads.parent_thread_id, threads.origin_turn_id,
// threads.active_leaf_turn_id, turns.parent_turn_id.
