/** Per-account recently opened documents used to resume writing across projects. */
import type { DocumentId, UserId } from "@meridian/contracts";
import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { documents } from "./content";
import { users } from "./users";

export const userRecentDocuments = pgTable(
  "user_recent_documents",
  {
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.documentId],
      name: "user_recent_documents_pk",
    }),
    index("user_recent_documents_user_opened_idx").on(table.userId, table.openedAt.desc()),
  ],
);
