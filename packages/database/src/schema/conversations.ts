import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, softDeleteAt, updatedAt } from "./_shared";
import { authUsers } from "./auth";
import { documents, projects } from "./content";
import { agentDefinitions } from "./package";

export const threads = pgTable(
  "threads",
  {
    id: idColumn(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    kind: text("kind").notNull().default("primary"),
    status: text("status").notNull().default("active"),
    currentAgentId: uuid("current_agent_id").references(() => agentDefinitions.id, {
      onDelete: "set null",
    }),
    workingState: jsonb("working_state"),
    parentThreadId: uuid("parent_thread_id"),
    originTurnId: uuid("origin_turn_id"),
    originType: text("origin_type"),
    handoffSummary: text("handoff_summary"),
    spawnStatus: text("spawn_status"),
    spawnResult: jsonb("spawn_result"),
    spawnDepth: integer("spawn_depth").notNull().default(0),
    activeLeafTurnId: uuid("active_leaf_turn_id"),
    turnCount: integer("turn_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
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
    check("threads_kind_valid", sql`${table.kind} IN ('primary', 'subagent')`),
    check("threads_status_valid", sql`${table.status} IN ('active', 'archived')`),
    check(
      "threads_origin_type_valid",
      sql`${table.originType} IS NULL OR ${table.originType} IN ('spawn', 'handoff', 'fork')`,
    ),
    check(
      "threads_spawn_origin_subagent",
      sql`${table.originType} != 'spawn' OR ${table.kind} = 'subagent'`,
    ),
    check(
      "threads_handoff_fork_primary",
      sql`${table.originType} NOT IN ('handoff', 'fork') OR ${table.kind} = 'primary'`,
    ),
    check(
      "threads_handoff_summary_origin",
      sql`${table.handoffSummary} IS NULL OR ${table.originType} = 'handoff'`,
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

export const turns = pgTable(
  "turns",
  {
    id: idColumn(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    parentTurnId: uuid("parent_turn_id"),
    agentDefinitionId: uuid("agent_definition_id").references(() => agentDefinitions.id, {
      onDelete: "set null",
    }),
    compactionModel: text("compaction_model"),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    finishReason: text("finish_reason"),
    error: text("error"),
    requestParams: jsonb("request_params"),
    totalInputTokens: integer("total_input_tokens"),
    totalOutputTokens: integer("total_output_tokens"),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }),
    totalMillicredits: bigint("total_millicredits", { mode: "number" }),
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
      sql`${table.status} IN ('pending', 'streaming', 'complete', 'cancelled', 'error')`,
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
    id: idColumn(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
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
  ],
);

export const turnBlocks = pgTable(
  "turn_blocks",
  {
    id: idColumn(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    modelResponseId: uuid("model_response_id").references(() => modelResponses.id, {
      onDelete: "set null",
    }),
    blockType: text("block_type").notNull(),
    sequence: integer("sequence").notNull(),
    textContent: text("text_content"),
    content: jsonb("content"),
    compact: text("compact"),
    pruned: boolean("pruned").notNull().default(false),
    executionSide: text("execution_side"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("turn_blocks_turn_sequence").on(table.turnId, table.sequence),
    index("turn_blocks_turn_type").on(table.turnId, table.blockType),
  ],
);

export const eventJournal = pgTable(
  "event_journal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonbDefault("payload"),
    createdAt: createdAt(),
  },
  (table) => [index("event_journal_thread_id").on(table.threadId, table.id)],
);

export const threadUserState = pgTable(
  "thread_user_state",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.userId] })],
);

export const threadDocuments = pgTable(
  "thread_documents",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull().default("editing"),
    firstTouchedAt: timestamp("first_touched_at", { withTimezone: true }).notNull().defaultNow(),
    lastTouchedAt: timestamp("last_touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.documentId] })],
);

// Deferred FKs in migration SQL: threads.parent_thread_id, threads.origin_turn_id,
// threads.active_leaf_turn_id, turns.parent_turn_id, context_sources.thread_id.
