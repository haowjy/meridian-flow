/**
 * Loro document storage (design §4, §2 of `loro-build`): a row per doc of a room, and a row per
 * draft fork of a document.
 */
import type { CommandId, DocumentId } from "@meridian/contracts";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { byteaColumn, createdAt } from "./_shared";
import { commands } from "./collab";
import { documents } from "./content";
import { draftIdColumn } from "./drafts";

/** A Loro frontier as JSON: the ops a snapshot is at. */
export type StoredFrontiers = { peer: string; counter: number }[];

/**
 * The snapshot of one doc of one room: `room_key` is the room's name (`live:<doc>`,
 * `fork:<draft>:<doc>`, `tree:<list>`), `doc_key` is `s` for a document's structure doc or a block
 * id for its text doc. A save upserts the rows of the docs that changed; a load reads the room's
 * rows. No foreign key: a fork room's rows go with its `document_forks` row by key prefix, at purge.
 */
export const documentSnapshots = pgTable(
  "document_snapshots",
  {
    roomKey: text("room_key").notNull(),
    docKey: text("doc_key").notNull(),
    snapshot: byteaColumn("snapshot").notNull(),
    frontiers: jsonb("frontiers").$type<StoredFrontiers>().notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Where a compaction may cut this doc's history: its frontiers at `history_mark_at`, set when
     * the row is made and again by each compaction. Loro changes carry no time, so this is how the
     * server knows the doc's frontier as of seven days ago (design §4, "History cutoff").
     */
    historyMark: jsonb("history_mark").$type<StoredFrontiers>().notNull(),
    historyMarkAt: timestamp("history_mark_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roomKey, table.docKey] })],
);

/**
 * A draft's fork of a document: created by the draft's first write into it, one per pair for the
 * pair's life. Its room is `fork:<draft_id>:<document_id>`.
 */
export const documentForks = pgTable(
  "document_forks",
  {
    draftId: draftIdColumn("draft_id").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Whether the fork differs from Live (`changedBlocks` is not empty), set on every save of its room. */
    pending: boolean("pending").notNull().default(false),
    /**
     * When `pending` was last set from a read of the fork: its room's last save, or the retention
     * job's check. A fork not loaded since keeps an old flag; the job reads it again once this is
     * 30 days old.
     */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    /** Since when the fork has had no change; null while it is pending. Retention deletes it 30 days on. */
    emptySince: timestamp("empty_since", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.documentId] }),
    index("document_forks_document").on(table.documentId),
  ],
);

/**
 * What a press of one draft on one document did, for its Undo: `changes` is the document model's
 * `PressedChange[]` (JSON), each change's members and, per room, its edit with the note taken at
 * press time, which can't be taken again later. A press of several drafts (a Work's `Apply all`)
 * presses them one after another in draft id order, so a command can have a row per draft. Its
 * Undo runs `undoPress` once per draft, in the reverse order; an Undo stores no rows (pressing
 * again is the Redo).
 */
export const pressChanges = pgTable(
  "press_changes",
  {
    commandId: uuid("command_id")
      .$type<CommandId>()
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    draftId: draftIdColumn("draft_id").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    changes: jsonb("changes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.commandId, table.draftId, table.documentId] })],
);
