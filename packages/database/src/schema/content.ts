import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";
import { authUsers } from "./auth";
import {
  createdAt,
  idColumn,
  jsonbDefault,
  softDeleteAt,
  updatedAt,
} from "./_shared";

export const projects = pgTable(
  "projects",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    systemPrompt: text("system_prompt"),
    settings: jsonbDefault("settings"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("projects_user_slug_active")
      .on(table.userId, table.slug)
      .where(sql`${table.deletedAt} is null`),
    index("projects_user_last_activity_active")
      .on(table.userId, table.lastActivityAt.desc())
      .where(sql`${table.deletedAt} is null`),
  ],
);

// thread_id FK added in custom SQL (circular dep with threads)
export const contextSources = pgTable(
  "context_sources",
  {
    id: idColumn(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    scope: text("scope").notNull().default("project"),
    adapterType: text("adapter_type").notNull().default("local"),
    adapterConfig: jsonbDefault("adapter_config"),
    syncState: jsonb("sync_state"),
    description: text("description"),
    isPrimary: boolean("is_primary").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("context_sources_project_slug")
      .on(table.projectId, table.slug)
      .where(sql`${table.threadId} is null`),
    uniqueIndex("context_sources_thread_slug")
      .on(table.threadId, table.slug)
      .where(sql`${table.threadId} is not null`),
    index("context_sources_project_sort").on(table.projectId, table.sortOrder),
    check(
      "context_sources_scope_thread_project",
      sql`${table.scope} = 'session' OR ${table.threadId} IS NULL`,
    ),
    check(
      "context_sources_scope_thread_session",
      sql`${table.scope} = 'project' OR ${table.threadId} IS NOT NULL`,
    ),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: idColumn(),
    contextSourceId: uuid("context_source_id")
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    index("folders_context_parent_active")
      .on(table.contextSourceId, table.parentId)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("folders_context_parent_name_active")
      .on(table.contextSourceId, table.parentId, table.name)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("folders_context_root_name_active")
      .on(table.contextSourceId, table.name)
      .where(sql`${table.parentId} is null AND ${table.deletedAt} is null`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: idColumn(),
    contextSourceId: uuid("context_source_id")
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    extension: text("extension").notNull().default("md"),
    fileType: text("file_type").notNull().default("markdown"),
    description: text("description"),
    storageUrl: text("storage_url"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    markdownProjection: text("markdown_projection").notNull().default(""),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    index("documents_context_folder_active")
      .on(table.contextSourceId, table.folderId)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("documents_context_folder_name_active")
      .on(table.contextSourceId, table.folderId, table.name, table.extension)
      .where(sql`${table.deletedAt} is null`),
    check(
      "documents_size_bytes_nonneg",
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
  ],
);

// folders.parent_id self-FK added in custom SQL migration
