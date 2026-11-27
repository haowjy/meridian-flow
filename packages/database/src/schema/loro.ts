import type { CommandId, DocumentId } from "@meridian/contracts";
import {
  boolean,
  index,
  integer,
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

export type StoredFrontiers = { peer: string; counter: number }[];

export const documentSnapshots = pgTable(
  "document_snapshots",
  {
    roomKey: text("room_key").notNull(),
    docKey: text("doc_key").notNull(),
    snapshot: byteaColumn("snapshot").notNull(),
    frontiers: jsonb("frontiers").$type<StoredFrontiers>().notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    historyMark: jsonb("history_mark").$type<StoredFrontiers>().notNull(),
    historyMarkAt: timestamp("history_mark_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.roomKey, table.docKey] })],
);

export const documentForks = pgTable(
  "document_forks",
  {
    draftId: draftIdColumn("draft_id").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pending: boolean("pending").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    emptySince: timestamp("empty_since", { withTimezone: true }),
    liveVersion: byteaColumn("live_version"),
    changeCount: integer("change_count").notNull().default(0),
    writerWrote: boolean("writer_wrote").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.documentId] }),
    index("document_forks_document").on(table.documentId),
  ],
);

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
