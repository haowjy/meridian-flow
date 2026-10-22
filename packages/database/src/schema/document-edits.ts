// Immutable document edit receipts, independent of compactable transport journals.
import type {
  DocumentId,
  EditOrigin,
  ThreadId,
  TreeChange,
  TurnId,
  UserId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
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
    actor: text("actor").$type<"agent" | "human" | "system">().notNull(),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    wId: integer("w_id"),
    kind: text("kind").$type<"write" | "undo" | "redo" | "revert" | "rollback">().notNull(),
    actionId: uuid("action_id"),
    consumes: jsonb("consumes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** A move, delete, restore or settlement: a tree entry, which has no parts. */
    treeChange: jsonb("tree_change").$type<TreeChange>(),
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
    check(
      "document_edits_tree_change_valid",
      sql`${t.treeChange} IS NULL OR (
        ${t.treeChange}->>'op' IN ('move','delete','restore','settle')
        AND ${t.treeChange}->'destination'->>'kind' IN ('live','draft')
        AND jsonb_typeof(${t.treeChange}->'seq') = 'number'
        AND jsonb_typeof(${t.treeChange}->'targets') = 'array'
        AND (${t.treeChange}->>'op' <> 'settle' OR ${t.treeChange} ? 'settles')
      )`,
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
    check("document_edit_parts_ordinal_valid", sql`${t.ordinal} >= 0`),
    check("document_edit_parts_origin_valid", sql`${t.origin}->>'kind' IN ('pending','live')`),
  ],
);
