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

/**
 * The next write handle (`e<N>`, agent-edit `editHandle`) a chat's writes to one document take,
 * so a model can name an earlier write of its own in that document.
 */
export const agentEditWidCounters = pgTable(
  "agent_edit_wid_counters",
  {
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    threadId: uuid("thread_id").$type<ThreadId>().notNull(),
    nextWid: integer("next_wid").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.threadId] })],
);

/**
 * One project's or account's tree list: the identity its rows (`tree_nodes`, `tree_node_ids`)
 * hang from, made with the project or account by a trigger, and taken by the owner's delete. The
 * list itself is stored in `document_snapshots` under `tree:<id>`.
 */
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

/**
 * One row per document: the live room's derived outputs, certified against one cut. `blockOrder`
 * is the only place a block's position lives, so inserting a paragraph rewrites one array, never
 * the block rows below it. The room is stale when `cut*` or `extractorVersion` differ from the
 * document's head, location version or the code's.
 */
export const documentBlockRooms = pgTable(
  "document_block_rooms",
  {
    roomId: bigint("room_id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The top-level blocks' ids in document order. */
    blockOrder: text("block_order").array().notNull(),
    wordCount: integer("word_count").notNull(),
    /**
     * By draft id, what it has pending in the cut: its review's change count, the chats that
     * wrote them, and whether one is no chat's. The blocks hold Live's text, so a reader in one
     * of these drafts' views reads the document itself.
     */
    pendingChanges: jsonb("pending_changes")
      .$type<Record<string, { changes: number; chats: string[]; writer: boolean }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Ordered block content hashes plus the certified link facts: `updated_at` moves with it. */
    documentHash: byteaColumn("document_hash").notNull(),
    /** The document's `content_seq` the derivation read. */
    cutContentSeq: bigint("cut_content_seq", { mode: "bigint" }).notNull(),
    cutLocationVersion: bigint("cut_location_version", { mode: "bigint" }).notNull(),
    extractorVersion: integer("extractor_version").notNull(),
  },
  (table) => [
    uniqueIndex("document_block_rooms_document").on(table.documentId),
    // A draft's documents with suggestions: `pending_changes ? <draft id>`.
    index("document_block_rooms_pending_changes").using("gin", table.pendingChanges),
  ],
);

/** One row per top-level block of a room, keyed by its block id. */
export const documentBlocks = pgTable(
  "document_blocks",
  {
    roomId: bigint("room_id", { mode: "number" })
      .notNull()
      .references(() => documentBlockRooms.roomId, { onDelete: "cascade" }),
    blockId: text("block_id").notNull(),
    /** What `grep` matches in this block (`grepBlockText` in agent-edit). */
    text: text("text").notNull(),
    /** Hash of the block's destination-free markdown: the diff key. */
    contentHash: byteaColumn("content_hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.blockId] })],
);

/**
 * One row per command sent as a request, of any kind, keyed by the sender's id, so a resend
 * answers the first command's outcome. The row is the effect transaction's first write and
 * holds its final outcome when it commits. Only the account is a foreign key: a row outlives
 * its project and its chat, so a late resend of a create cannot create twice. A chat purge
 * deletes the chat's rows by `thread_id` (`model_edit` today); nothing else removes one.
 */
export const commands = pgTable(
  "commands",
  {
    id: uuid("id").$type<CommandId>().primaryKey(),
    kind: text("kind").$type<CommandKind>().notNull(),
    accountId: uuid("account_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null for a command on account-level documents; plain, so a project's rows outlive it. */
    projectId: uuid("project_id").$type<ProjectId>(),
    /** The chat of a `model_edit` command, so a purge of the chat deletes its stored tool results. */
    threadId: uuid("thread_id").$type<ThreadId>(),
    /**
     * Hash of the canonical request; another digest under this id is a conflict. Null only on a
     * `never` row a resolve stored: it answers `never` to every attempt, whatever its digest.
     */
    requestDigest: text("request_digest"),
    outcome: jsonb("outcome").$type<CommandOutcome>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("commands_thread").on(table.threadId),
    check(
      "commands_kind_valid",
      sql`${table.kind} IN ('model_edit', 'reverse_turn', 'copy', 'work_create', 'work_update', 'work_archive', 'work_unarchive', 'work_delete', 'work_restore', 'project_create', 'thread_set_overrides', 'press', 'unpress', 'draft_create', 'draft_rename', 'draft_delete', 'draft_restore', 'chat_draft')`,
    ),
  ],
);

/**
 * The tree half of a press Apply: one row per draft and list the command settled records in. Its
 * Undo reads which drafts and lists to take back.
 */
export const applyCommandTrees = pgTable(
  "apply_command_trees",
  {
    commandId: uuid("command_id")
      .$type<CommandId>()
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    draftId: draftIdColumn("draft_id").notNull(),
    /** The project's list, or its owner's account list (`user://`). */
    scope: text("scope").$type<"project" | "account">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.draftId, table.scope] })],
);
