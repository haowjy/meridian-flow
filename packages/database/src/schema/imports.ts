/** Resumable folder/file import records and identity-bearing entry receipts. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./content";
export const imports = pgTable("imports", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  manifest: jsonb("manifest").notNull(),
  fingerprint: text("fingerprint").notNull(),
  sourceId: uuid("source_id").notNull(),
  folderId: uuid("folder_id"),
  state: text("state").notNull(),
});
export const importEntries = pgTable(
  "import_entries",
  {
    id: uuid("id").primaryKey(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    spec: jsonb("spec").notNull(),
    state: text("state").notNull(),
    created: boolean("created").notNull().default(false),
    attemptId: uuid("attempt_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    storageUrl: text("storage_url"),
    uri: text("uri"),
  },
  (table) => [index("import_entries_import_order").on(table.importId, table.ordinal)],
);
