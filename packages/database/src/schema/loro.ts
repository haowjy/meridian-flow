/**
 * Loro document storage (design §4, §2 of `loro-build`): a row per doc of a room, and a row per
 * draft fork of a document. Beside the Yjs tables until the cutover drops them.
 */
import type { DocumentId } from "@meridian/contracts";
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { byteaColumn, createdAt } from "./_shared";
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
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.documentId] }),
    index("document_forks_document").on(table.documentId),
  ],
);
