/** Durable asks that settle an execution and are answered by a later continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  AskContinuationState,
  AskKind,
  AskPayload,
  AskResolution,
  AskStatus,
  DraftAnswers,
} from "@meridian/contracts/threads";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./_shared";
import { threads, turns } from "./agent-threads";
import { projects } from "./content";

export const projectActionGrants = pgTable(
  "project_action_grants",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("project_action_grants_project_action_unique").on(table.projectId, table.action),
  ],
);

export const asks = pgTable(
  "asks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    askingTurnId: uuid("asking_turn_id").$type<TurnId>().notNull(),
    executionId: uuid("execution_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    kind: text("kind").$type<AskKind>().notNull(),
    payload: jsonb("payload").$type<AskPayload>().notNull(),
    /** Validated server-only command. Never serialized through threadAsk(). */
    permissionCommand: jsonb("permission_command").$type<Record<string, unknown>>(),
    /** When a question ask settled the run and opened; its hard timeout limit counts from here. */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** The answers a writer had chosen when they last interacted; a timeout resolves from them. */
    draftAnswers: jsonb("draft_answers").$type<DraftAnswers>(),
    status: text("status").$type<AskStatus>().notNull().default("pending"),
    resolution: jsonb("resolution").$type<AskResolution>(),
    submissionId: text("submission_id"),
    continuation: text("continuation").$type<AskContinuationState>(),
    /** The latest turn admitted to continue this ask. */
    continuationTurnId: uuid("continuation_turn_id").$type<TurnId>(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.askingTurnId],
      foreignColumns: [turns.threadId, turns.id],
      name: "asks_asking_turn_fk",
    }).onDelete("cascade"),
    unique("asks_turn_tool_call_unique").on(table.askingTurnId, table.toolCallId),
    index("asks_open_deadline")
      .on(table.deadlineAt, table.id)
      .where(sql`${table.status} = 'open' AND ${table.deadlineAt} IS NOT NULL`),
    index("asks_thread_created").on(table.threadId, table.createdAt, table.id),
    // The rows a thread lock takes before its own lock: live asks and owed continuations.
    index("asks_held_by_thread")
      .on(table.threadId)
      .where(sql`${table.status} IN ('pending', 'open') OR ${table.continuation} = 'pending'`),
    uniqueIndex("asks_one_live_per_thread")
      .on(table.threadId)
      .where(sql`${table.status} IN ('pending', 'open')`),
    check("asks_kind_valid", sql`${table.kind} IN ('question', 'permission')`),
    check(
      "asks_permission_command_coherent",
      sql`(${table.kind} = 'permission' AND ${table.permissionCommand} IS NOT NULL) OR (${table.kind} = 'question' AND ${table.permissionCommand} IS NULL)`,
    ),
    check(
      "asks_status_valid",
      sql`${table.status} IN ('pending', 'open', 'answered', 'expired', 'cancelled')`,
    ),
    check(
      "asks_resolution_coherent",
      sql`(${table.status} IN ('pending', 'open') AND ${table.resolution} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.status} IN ('answered', 'expired', 'cancelled') AND ${table.resolution} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);
