/** Resumable folder/file import records and identity-bearing entry receipts. */
import { sql } from "drizzle-orm";
import {
  bigint,
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
export const imports = pgTable(
  "imports",
  {
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Open-import polls filter by project and order newest first; project deletes follow the FK.
  (table) => [index("imports_project_created").on(table.projectId, table.createdAt)],
);
export const importEntries = pgTable(
  "import_entries",
  {
    id: uuid("id").primaryKey(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** Planned node fields no query filters on. */
    spec: jsonb("spec").notNull(),
    kind: text("kind").notNull(),
    /** The manifest file's id; null for folders. */
    entryId: integer("entry_id"),
    parentId: uuid("parent_id"),
    area: text("area"),
    /** Whether the planning chunk has reserved this entry's name. */
    prepared: boolean("prepared").notNull().default(false),
    state: text("state").notNull(),
    created: boolean("created").notNull().default(false),
    attemptId: uuid("attempt_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    storageUrl: text("storage_url"),
    uri: text("uri"),
    /** Last object-key reclamation; a recorded late put clears it so the next sweep retries. */
    objectSweptAt: timestamp("object_swept_at", { withTimezone: true }),
    version: bigint("version", { mode: "bigint" }).notNull().default(sql.raw("0")),
  },
  (table) => [
    index("import_entries_import_order").on(table.importId, table.ordinal),
    index("import_entries_import_version").on(table.importId, table.version),
    index("import_entries_object_sweep")
      .on(table.leaseUntil)
      .where(
        sql`${table.attemptId} IS NOT NULL AND ${table.state} IN ('deleted','not_imported') AND ${table.kind} = 'binary'`,
      ),
  ],
);

/** Commit-order progress is separate from the row held FOR SHARE by parallel landings. */
export const importProgress = pgTable("import_progress", {
  importId: uuid("import_id")
    .primaryKey()
    .references(() => imports.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "bigint" }).notNull().default(sql.raw("0")),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});
