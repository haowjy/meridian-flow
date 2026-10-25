/** Durable asks that settle an execution and are answered by a later continuation. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { AskKind, AskPayload, AskResolution, AskStatus } from "@meridian/contracts/threads";
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
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./_shared";
import { threads, turns } from "./agent-threads";

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
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    status: text("status").$type<AskStatus>().notNull().default("pending"),
    resolution: jsonb("resolution").$type<AskResolution>(),
    submissionId: text("submission_id"),
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
    check("asks_kind_valid", sql`${table.kind} IN ('question', 'permission')`),
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
