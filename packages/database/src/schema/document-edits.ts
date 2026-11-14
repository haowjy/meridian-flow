// Immutable document edit receipts, independent of compactable transport journals.
import type {
  BranchId,
  DocumentId,
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
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt, idColumn } from "./_shared";
import { threads, turns } from "./agent-threads";
import { documents } from "./content";
import { users } from "./users";

type Range = { client: number; clock: number; len: number };
type Alias = {
  source: { client: number; clock: number };
  target: { client: number; clock: number };
  len: number;
};

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
    editScopeId: text("edit_scope_id"),
    /** The model tool call that made this edit; scoped by its response identity. */
    toolCallId: text("tool_call_id"),
    actor: text("actor").$type<"agent" | "human" | "system">().notNull(),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    wId: integer("w_id"),
    kind: text("kind").$type<"write" | "undo" | "redo" | "revert" | "rollback">().notNull(),
    actionId: uuid("action_id"),
    consumes: jsonb("consumes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("document_edits_document_idx").on(t.documentId),
    index("document_edits_turn_idx").on(t.turnId),
    index("document_edits_action_idx").on(t.actionId),
    check("document_edits_actor_valid", sql`${t.actor} IN ('agent','human','system')`),
    check(
      "document_edits_kind_valid",
      sql`${t.kind} IN ('write','undo','redo','revert','rollback')`,
    ),
  ],
);
export const documentEditParts = pgTable(
  "document_edit_parts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    editId: uuid("edit_id")
      .notNull()
      .references(() => documentEdits.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    update: byteaColumn("update").notNull(),
    effect: jsonb("effect").$type<{ inserted: Range[]; deleted: Range[] }>().notNull(),
    targets: jsonb("targets")
      .$type<{ editId: string; ordinal: number; direction: "invert" | "reapply" }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    frontier: jsonb("frontier").$type<Record<string, number>>().notNull(),
    aliases: jsonb("aliases").$type<Alias[]>().notNull().default(sql`'[]'::jsonb`),
    origin: jsonb("origin").$type<EditOrigin>().notNull(),
  },
  (t) => [
    uniqueIndex("document_edit_parts_edit_ordinal").on(t.editId, t.ordinal),
    index("document_edit_parts_pending_origin_idx")
      .on(sql`(${t.origin}->>'draftId')`)
      .where(sql`${t.origin}->>'kind' = 'pending'`),
    index("document_edit_parts_live_origin_seq")
      .on(sql`((${t.origin}->>'seq')::bigint)`)
      .where(sql`${t.origin}->>'kind' = 'live'`),
    check("document_edit_parts_ordinal_valid", sql`${t.ordinal} >= 0`),
    check("document_edit_parts_origin_valid", sql`${t.origin}->>'kind' IN ('pending','live')`),
  ],
);

/**
 * What a tree command did, for the chat that made it: one row per tool call. `records` are the
 * records it admitted, which Undo names to the package one by one (`undoChange`, resolving
 * through copies); `w_id` is the model's handle on `node_id`'s counter for this chat. A row of
 * kind `undo` or `redo` names the receipt it reverses.
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
    editScopeId: text("edit_scope_id"),
    toolCallId: text("tool_call_id"),
    /** A document's or a folder's node id: a folder has no `documents` row. */
    nodeId: uuid("node_id").notNull(),
    /** The records the call admitted, in the order it made them. */
    records: jsonb("records").$type<{ record: string; node: string }[]>().notNull(),
    op: text("op").$type<"create" | "move" | "delete" | "restore">().notNull(),
    kind: text("kind").$type<"write" | "undo" | "redo">().notNull().default("write"),
    reverses: uuid("reverses"),
    wId: integer("w_id").notNull(),
    /** The Work's branch the record was drafted in; null when it is live. */
    draftBranchId: uuid("draft_branch_id").$type<BranchId>(),
    /** The path the model gave, and where the node landed, for the turn's receipt lines. */
    shownAt: text("shown_at"),
    landedAt: text("landed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tree_edit_receipts_node_idx").on(t.nodeId, t.threadId, t.seq),
    index("tree_edit_receipts_turn_idx").on(t.turnId),
    check("tree_edit_receipts_op_valid", sql`${t.op} IN ('create','move','delete','restore')`),
    check("tree_edit_receipts_kind_valid", sql`${t.kind} IN ('write','undo','redo')`),
    check(
      "tree_edit_receipts_reverses_valid",
      sql`(${t.kind} = 'write') = (${t.reverses} IS NULL)`,
    ),
  ],
);
