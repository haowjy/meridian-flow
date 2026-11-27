import type { CommandId, DocumentId, ProjectId, ThreadId, UserId } from "@meridian/contracts";
import type { CommandKind, CommandOutcome } from "@meridian/contracts/commands";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt } from "./_shared";
import { threads } from "./agent-threads";
import { documents, projects } from "./content";
import { draftIdColumn } from "./drafts";
import { users } from "./users";

export const pendingNotices = pgTable(
  "pending_notices",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("pending_notices_thread").on(table.threadId, table.createdAt, table.id)],
);

export const agentEditWidCounters = pgTable(
  "agent_edit_wid_counters",
  {
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    nextWid: integer("next_wid").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.threadId] })],
);

export const treeLists = pgTable(
  "tree_lists",
  {
    id: uuid("id").$type<DocumentId>().primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("tree_lists_one_owner", sql`num_nonnulls(${table.projectId}, ${table.userId}) = 1`),
  ],
);

export const documentBlockRooms = pgTable(
  "document_block_rooms",
  {
    roomId: bigint("room_id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    blockOrder: text("block_order").array().notNull(),
    wordCount: integer("word_count").notNull(),
    documentHash: byteaColumn("document_hash").notNull(),
    cutContentSeq: bigint("cut_content_seq", { mode: "bigint" }).notNull(),
    cutLocationVersion: bigint("cut_location_version", { mode: "bigint" }).notNull(),
    extractorVersion: integer("extractor_version").notNull(),
  },
  (table) => [uniqueIndex("document_block_rooms_document").on(table.documentId)],
);

export const documentBlocks = pgTable(
  "document_blocks",
  {
    roomId: bigint("room_id", { mode: "number" })
      .notNull()
      .references(() => documentBlockRooms.roomId, { onDelete: "cascade" }),
    blockId: text("block_id").notNull(),
    text: text("text").notNull(),
    contentHash: byteaColumn("content_hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.blockId] })],
);

export const commands = pgTable(
  "commands",
  {
    id: uuid("id").$type<CommandId>().primaryKey(),
    kind: text("kind").$type<CommandKind>().notNull(),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").$type<ProjectId>(),
    threadId: uuid("thread_id").$type<ThreadId>(),
    requestDigest: text("request_digest"),
    outcome: jsonb("outcome").$type<CommandOutcome>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("commands_thread").on(table.threadId),
    check(
      "commands_kind_valid",
      sql`${table.kind} IN ('model_edit', 'reverse_turn', 'copy', 'work_create', 'work_update', 'work_archive', 'work_unarchive', 'work_delete', 'work_restore', 'project_create', 'project_rename', 'thread_set_overrides', 'chat_rename', 'press', 'unpress', 'draft_create', 'draft_rename', 'draft_delete', 'draft_restore', 'chat_draft')`,
    ),
  ],
);

export const applyCommandTrees = pgTable(
  "apply_command_trees",
  {
    commandId: uuid("command_id")
      .$type<CommandId>()
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    draftId: draftIdColumn("draft_id").notNull(),
    scope: text("scope").$type<"project" | "account">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.draftId, table.scope] })],
);
