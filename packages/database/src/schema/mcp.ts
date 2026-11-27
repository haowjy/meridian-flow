import type { ProjectId, ThreadId, UserId } from "@meridian/contracts";
import type {
  McpConnectionId,
  McpConnectionSpec,
  McpConnectionStatus,
  McpPin,
  McpPinId,
} from "@meridian/contracts/mcp";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, softDeleteAt, updatedAt } from "./_shared";
import { threads } from "./agent-threads";
import { projects } from "./content";
import { users } from "./users";

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: idColumn<McpConnectionId>(),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    spec: jsonb("spec").$type<McpConnectionSpec>().notNull(),
    currentPinId: uuid("current_pin_id")
      .$type<McpPinId>()
      .references((): AnyPgColumn => mcpPins.id),
    settingsVersion: integer("settings_version").notNull().default(1),
    status: text("status").$type<McpConnectionStatus>(),
    statusReason: text("status_reason"),
    statusVersion: integer("status_version"),
    statusStartedAt: timestamp("status_started_at", { withTimezone: true }),
    checkFinishedAt: timestamp("check_finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("mcp_connections_account_name")
      .on(table.accountId, table.name)
      .where(sql`${table.projectId} IS NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("mcp_connections_project_name")
      .on(table.projectId, table.name)
      .where(sql`${table.projectId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index("mcp_connections_account").on(table.accountId),
    check("mcp_connections_name_valid", sql`${table.name} ~ '^[A-Za-z0-9_-]{1,40}$'`),
    check(
      "mcp_connections_status_valid",
      sql`${table.status} IS NULL OR ${table.status} IN ('connected', 'unreachable', 'needs_sign_in')`,
    ),
  ],
);

export const mcpPins = pgTable(
  "mcp_pins",
  {
    id: idColumn<McpPinId>(),
    connectionId: uuid("connection_id")
      .$type<McpConnectionId>()
      .notNull()
      .references((): AnyPgColumn => mcpConnections.id, { onDelete: "cascade" }),
    pin: jsonb("pin").$type<McpPin>().notNull(),
    pinHash: text("pin_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("mcp_pins_connection_created").on(table.connectionId, table.createdAt)],
);

// MCP tokens are AES-256-GCM ciphertext under MCP_TOKEN_KEY and are never returned to the app
export const mcpConnectionTokens = pgTable(
  "mcp_connection_tokens",
  {
    connectionId: uuid("connection_id")
      .$type<McpConnectionId>()
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.accountId] })],
);

export const mcpCalls = pgTable(
  "mcp_calls",
  {
    id: idColumn<string>(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(),
    modelResponseId: uuid("model_response_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    sequence: integer("sequence").notNull(),
    connectionId: uuid("connection_id").$type<McpConnectionId>().notNull(),
    pinId: uuid("pin_id").$type<McpPinId>().notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").notNull(),
    outcomeKind: text("outcome_kind"),
    replyRef: jsonb("reply_ref"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("mcp_calls_thread_turn").on(table.threadId, table.turnId)],
);
