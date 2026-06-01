import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn } from "./_shared";
import { documents } from "./content";
import { threads, turns } from "./conversations";

export const turnDocumentTouches = pgTable(
  "turn_document_touches",
  {
    id: idColumn(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("turn_document_touches_turn_document").on(table.turnId, table.documentId),
    index("turn_document_touches_document_touched").on(table.documentId, table.touchedAt.desc()),
    index("turn_document_touches_turn").on(table.turnId),
  ],
);
