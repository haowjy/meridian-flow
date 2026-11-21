import type {
  BranchId,
  CommandId,
  DocumentAuthorityId,
  DocumentId,
  ModelResponseId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { CommandKind, CommandOutcome } from "@meridian/contracts/commands";
import { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
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
import { byteaColumn, createdAt } from "./_shared";
import { threads, turns } from "./agent-threads";
import { branches } from "./branches";
import { documents, projects } from "./content";
import { documentEdits } from "./document-edits";
import { users } from "./users";

export const documentYjsCheckpoints = pgTable(
  "document_yjs_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references((): AnyPgColumn => documentYjsHeads.documentId, { onDelete: "cascade" }),
    authorityId: uuid("authority_id").$type<DocumentAuthorityId>().notNull(),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull(),
    attributionManifest: jsonb("attribution_manifest").$type<unknown>().notNull(),
    state: byteaColumn("state").notNull(),
    stateVector: byteaColumn("state_vector").notNull(),
    upToSeq: bigint("up_to_seq", { mode: "number" }).notNull(),
    reason: text("reason"),
    /**
     * Written by a room store to shorten a load's replay: each one deletes the document's earlier
     * background checkpoints. Seeds with content, explicit checkpoints and restores are never
     * background, whatever their `reason` says.
     */
    background: boolean("background").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    index("document_yjs_checkpoints_document_id_desc").on(table.documentId, table.id.desc()),
    uniqueIndex("document_yjs_checkpoints_initial")
      .on(table.documentId)
      .where(sql`${table.upToSeq} = 0`),
  ],
);

export const documentYjsUpdates = pgTable(
  "document_yjs_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references((): AnyPgColumn => documentYjsHeads.documentId, { onDelete: "cascade" }),
    authorityId: uuid("authority_id").$type<DocumentAuthorityId>().notNull(),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull(),
    admissionSequence: bigint("admission_sequence", { mode: "bigint" }).notNull(),
    batchOrdinal: integer("batch_ordinal").notNull().default(0),
    updateData: byteaColumn("update_data").notNull(),
    editId: uuid("edit_id").references(() => documentEdits.id, { onDelete: "set null" }),
    originType: text("origin_type"),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, {
        onDelete: "set null",
      }),
    actorTurnId: uuid("actor_turn_id")
      .$type<TurnId>()
      .references(() => turns.id, {
        onDelete: "set null",
      }),
    authoringResponseId: uuid("authoring_response_id").$type<ModelResponseId>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("document_yjs_updates_document_id").on(table.documentId, table.id),
    uniqueIndex("document_yjs_updates_authority_admission").on(
      table.authorityId,
      table.authorityGeneration,
      table.admissionSequence,
      table.batchOrdinal,
    ),
  ],
);

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

/**
 * One row per Yjs document, the identity its journal rows (`document_yjs_updates`,
 * `document_yjs_checkpoints`) hang from, of one `kind`. A `document` head's `document_id` is a
 * `documents.id`; it names no `documents` row of its own, so a Yjs document can exist before its
 * `documents` row does (an import writes text first), and a `documents` delete takes its head
 * and journal through a trigger. A `tree_list` head is a list's (a project's or an account's):
 * its id is the project's or account's `tree_list_id`, made with it by a trigger, and `project_id`
 * or `user_id` names the owner whose delete takes it. A list needs no living document to be
 * written, and no document's id is ever a list's.
 */
export const documentYjsHeads = pgTable(
  "document_yjs_heads",
  {
    documentId: uuid("document_id").$type<DocumentId>().primaryKey(),
    kind: text("kind").$type<"document" | "tree_list">().notNull().default("document"),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "cascade" }),
    authorityId: uuid("authority_id")
      .$type<DocumentAuthorityId>()
      .notNull()
      .default(sql`gen_random_uuid()`),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    nextAdmissionSequence: bigint("next_admission_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    fragmentName: text("fragment_name").notNull().default("prosemirror"),
    schemaVersion: integer("schema_version")
      .notNull()
      .default(packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)),
    latestUpdateSeq: bigint("latest_update_seq", { mode: "number" }).notNull().default(0),
    latestStateVector: byteaColumn("latest_state_vector"),
    /** No foreign key: checkpoints reference their head, and a cycle has no delete order. */
    latestCheckpointId: bigint("latest_checkpoint_id", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("document_yjs_heads_kind_valid", sql`${table.kind} IN ('document', 'tree_list')`),
    check(
      "document_yjs_heads_list_has_one_owner",
      sql`(${table.kind} = 'tree_list') = (num_nonnulls(${table.projectId}, ${table.userId}) = 1)`,
    ),
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
    /** Block ids ("<clientID>:<clock>" of the top-level element) in document order. */
    blockOrder: text("block_order").array().notNull(),
    wordCount: integer("word_count").notNull(),
    /**
     * By Work (`draftOwnerKey`), what it has pending in the cut: its review's change count, the
     * chats that wrote them, and whether one is no chat's. The blocks hold Live's text, so a
     * reader in one of these Works' views reads the document itself.
     */
    pendingChanges: jsonb("pending_changes")
      .$type<Record<string, { changes: number; chats: string[]; writer: boolean }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Ordered block content hashes plus the certified link facts: `updated_at` moves with it. */
    documentHash: byteaColumn("document_hash").notNull(),
    cutGeneration: bigint("cut_generation", { mode: "bigint" }).notNull(),
    cutAdmissionSeq: bigint("cut_admission_seq", { mode: "bigint" }).notNull(),
    cutLocationVersion: bigint("cut_location_version", { mode: "bigint" }).notNull(),
    extractorVersion: integer("extractor_version").notNull(),
  },
  (table) => [
    uniqueIndex("document_block_rooms_document").on(table.documentId),
    // A Work's documents with suggestions: `pending_changes ? <owner key>`.
    index("document_block_rooms_pending_changes").using("gin", table.pendingChanges),
  ],
);

/** One row per top-level block of a room, keyed by its Yjs item id. */
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
    // Trash lists a project's press Discards.
    index("commands_press_project")
      .on(table.projectId, table.createdAt)
      .where(sql`${table.kind} = 'press'`),
    check(
      "commands_kind_valid",
      sql`${table.kind} IN ('model_edit', 'reverse_turn', 'copy', 'work_create', 'work_update', 'work_archive', 'work_unarchive', 'work_delete', 'work_restore', 'project_create', 'thread_set_overrides', 'press', 'unpress')`,
    ),
  ],
);

/**
 * The tree half of a press Apply: one row per list the command settled records in, with the
 * list's state vector right after (its Undo is allowed only while the list still has it).
 */
export const applyCommandTrees = pgTable(
  "apply_command_trees",
  {
    commandId: uuid("command_id")
      .$type<CommandId>()
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .$type<BranchId>()
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    /** The project's list, or its owner's account list (`user://`). */
    scope: text("scope").$type<"project" | "account">().notNull(),
    mark: byteaColumn("mark").notNull(),
    /** The nodes whose live copies this Apply made in this list: what its Undo writes. */
    nodes: jsonb("nodes").$type<string[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.scope] })],
);

/**
 * The text half of a press: what the press's one transaction in this document
 * inserted and deleted, as Yjs id ranges by client (`[clock, len]`), and the authority generation
 * it ran on. The press's Undo is a Yjs undo of these ranges; a restore since (another generation)
 * ends it. Server documents keep deleted items (`gc: false`), which the undo needs.
 */
export const pressTextEffects = pgTable(
  "press_text_effects",
  {
    commandId: uuid("command_id")
      .$type<CommandId>()
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    authorityGeneration: bigint("authority_generation", { mode: "bigint" }).notNull(),
    insertions: jsonb("insertions").$type<Record<string, [number, number][]>>().notNull(),
    deletions: jsonb("deletions").$type<Record<string, [number, number][]>>().notNull(),
    /** The Undo that took it back: a press is taken back once. */
    undoneBy: uuid("undone_by").$type<CommandId>(),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.documentId] })],
);
