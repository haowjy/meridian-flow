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
import { createdAt, idColumn } from "./_shared";
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
    commandId: uuid("command_id").$type<CommandId>(),
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
    targets: jsonb("targets")
      .$type<{ editId: string; ordinal: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    delta: jsonb("delta").$type<EditDeltaJson | null>(),
    origin: jsonb("origin").$type<EditOrigin>().notNull(),
    edit: jsonb("edit"),
  },
  (t) => [
    uniqueIndex("document_edit_parts_edit_ordinal").on(t.editId, t.ordinal),
    check("document_edit_parts_ordinal_valid", sql`${t.ordinal} >= 0`),
    check(
      "document_edit_parts_origin_valid",
      sql`${t.origin}->>'kind' = 'live' OR (${t.origin}->>'kind' = 'fork' AND ${t.origin}->>'draftId' IS NOT NULL)`,
    ),
  ],
);

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
    commandId: uuid("command_id").$type<CommandId>(),
    toolCallId: text("tool_call_id"),
    nodeId: uuid("node_id").notNull(),
    records: jsonb("records").$type<{ record: string; node: string }[]>().notNull(),
    op: text("op").$type<"create" | "move" | "delete" | "restore">().notNull(),
    kind: text("kind").$type<"write" | "undo" | "redo">().notNull().default("write"),
    reverses: uuid("reverses"),
    draftId: text("draft_id").$type<DraftId>(),
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

// keep: w_id is the shared write ordinal; Undo, Redo and revert order text and tree changes by it
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
