/** Private Context creation rows, inaccessible to live catalog and document readers. */
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./content";

const node = () => ({
  stagingId: uuid("staging_id").notNull(),
  id: uuid("id").notNull(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  parentId: uuid("parent_id"),
  area: text("area").notNull(),
  name: text("name").notNull(),
});
export const contextStagedFolders = pgTable("context_staged_folders", node(), (table) => [
  primaryKey({ columns: [table.stagingId, table.id] }),
  index("context_staged_folders_project_idx").on(table.projectId),
]);
export const contextStagedDocuments = pgTable(
  "context_staged_documents",
  {
    ...node(),
    extension: text("extension").notNull(),
    filetype: text("filetype").notNull(),
    metadata: jsonb("metadata").notNull(),
    origin: jsonb("origin").notNull(),
    storageUrl: text("storage_url"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    aheadMints: jsonb("ahead_mints").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.stagingId, table.id] }),
    index("context_staged_documents_project_idx").on(table.projectId),
  ],
);
