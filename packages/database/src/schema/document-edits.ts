// Immutable document edit receipts, independent of compactable transport journals.
import type {
  CommandId,
  DocumentId,
  DraftId,
  EditOrigin,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
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
import { byteaColumn, createdAt, idColumn } from "./_shared";
import { threads, turns } from "./agent-threads";
import { documents } from "./content";
import { users } from "./users";

export type { EditOrigin } from "@meridian/contracts";
export const documentEdits = pgTable(
  "document_edits",
  {
    id: idColumn(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "set null" }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    responseId: text("response_id"),
    /** The command that made this edit; no foreign key: the receipt outlives the command row. */
    commandId: uuid("command_id").$type<CommandId>(),
    /** The model tool call that made this edit; scoped by its response identity. */
    toolCallId: text("tool_call_id"),
    actor: text("actor").$type<"agent" | "human" | "system">().notNull(),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    wId: integer("w_id"),
    kind: text("kind").$type<"write" | "undo" | "revert">().notNull(),
    actionId: uuid("action_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("document_edits_document_idx").on(t.documentId),
    index("document_edits_turn_idx").on(t.turnId),
    index("document_edits_action_idx").on(t.actionId),
    index("document_edits_command_idx").on(t.commandId),
    check("document_edits_actor_valid", sql`${t.actor} IN ('agent','human','system')`),
    check("document_edits_kind_valid", sql`${t.kind} IN ('write','undo','revert')`),
  ],
);
export type EditDeltaJson = { before: Record<string, unknown>[]; after: Record<string, unknown>[] };

export const documentEditParts = pgTable(
  "document_edit_parts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    editId: uuid("edit_id")
      .notNull()
      .references(() => documentEdits.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    update: byteaColumn("update").notNull(),
    targets: jsonb("targets")
      .$type<{ editId: string; ordinal: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The blocks the part changed, before and after the write merged in, as ProseMirror JSON with
     * one unchanged block either side. What the card and the model's Undo read the edit from; null
     * for a part written before the column or one that no AI wrote.
     */
    delta: jsonb("delta").$type<EditDeltaJson | null>(),
    origin: jsonb("origin").$type<EditOrigin>().notNull(),
  },
  (t) => [
    uniqueIndex("document_edit_parts_edit_ordinal").on(t.editId, t.ordinal),
    check("document_edit_parts_ordinal_valid", sql`${t.ordinal} >= 0`),
    check("document_edit_parts_origin_valid", sql`${t.origin}->>'kind' = 'live'`),
  ],
);

/**
 * What a tree command did, for the chat that made it: one row per tool call. `records` are the
 * records it admitted, which Undo names to the package one by one (`undoChange`, resolving
 * through copies). `node_id` is the subject the model's handle hangs on; every node the call
 * changed is in `tree_edit_receipt_nodes`. A row of kind `undo` or `redo` names the receipt it
 * reverses.
 */
export const treeEditReceipts = pgTable(
  "tree_edit_receipts",
  {
    id: idColumn(),
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, {
        onDelete: "set null",
      }),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .references(() => turns.id, { onDelete: "set null" }),
    responseId: text("response_id"),
    /** The command that made this change; no foreign key: the receipt outlives the command row. */
    commandId: uuid("command_id").$type<CommandId>(),
    toolCallId: text("tool_call_id"),
    /** A document's or a folder's node id: a folder has no `documents` row. */
    nodeId: uuid("node_id").notNull(),
    /** The records the call admitted, in the order it made them. */
    records: jsonb("records").$type<{ record: string; node: string }[]>().notNull(),
    op: text("op").$type<"create" | "move" | "delete" | "restore">().notNull(),
    kind: text("kind").$type<"write" | "undo" | "redo">().notNull().default("write"),
    reverses: uuid("reverses"),
    /** The draft the record was drafted in; null when it is live. No FK: the receipt outlives it. */
    draftId: text("draft_id").$type<DraftId>(),
    /** The path the model gave, for the turn's receipt lines and the Undo of a deleted node. */
    shownAt: text("shown_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tree_edit_receipts_thread_idx").on(t.threadId, t.shownAt),
    index("tree_edit_receipts_turn_idx").on(t.turnId),
    index("tree_edit_receipts_command_idx").on(t.commandId),
    index("tree_edit_receipts_reverses_idx").on(t.reverses),
    check("tree_edit_receipts_op_valid", sql`${t.op} IN ('create','move','delete','restore')`),
    check("tree_edit_receipts_kind_valid", sql`${t.kind} IN ('write','undo','redo')`),
    check(
      "tree_edit_receipts_reverses_valid",
      sql`(${t.kind} = 'write') = (${t.reverses} IS NULL)`,
    ),
  ],
);

/**
 * A node a tree receipt changed, in the chat's one history of that node: `w_id` is the write
 * ordinal reserved on the node's counter (`agentEditWidCounters`), the same sequence the node's
 * text edits take, so Undo, Redo and `revert` order text and tree changes by it. `before_at` and
 * `after_at` are the node's address before and after (null for a node the call created or
 * deleted), for the turn's change viewer. `copied_from` is the source address of a copy.
 */
export const treeEditReceiptNodes = pgTable(
  "tree_edit_receipt_nodes",
  {
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => treeEditReceipts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
      .references(() => threads.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull(),
    wId: integer("w_id").notNull(),
    copiedFrom: text("copied_from"),
    beforeAt: text("before_at"),
    afterAt: text("after_at"),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.nodeId] }),
    index("tree_edit_receipt_nodes_node_idx").on(t.threadId, t.nodeId, t.wId),
  ],
);
