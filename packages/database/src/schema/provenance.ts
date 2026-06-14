import type { DocumentId, ThreadId, TurnDocumentTouchId, TurnId } from "@meridian/contracts";
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn } from "./_shared";
import { threads, turns } from "./agent-threads";
import { documents } from "./content";

export const turnDocumentTouches = pgTable(
  "turn_document_touches",
  {
    id: idColumn<TurnDocumentTouchId>(),
    turnId: uuid("turn_id")
      .$type<TurnId>()
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .$type<ThreadId>()
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
