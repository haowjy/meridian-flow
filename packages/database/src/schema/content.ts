import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, softDeleteAt, updatedAt } from "./_shared";
import { authUsers } from "./auth";

export const projects = pgTable(
  "projects",
  {
    id: idColumn<ProjectId>(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isPersonal: boolean("is_personal").notNull().default(false),
    systemPrompt: text("system_prompt"),
    settings: jsonbDefault("settings"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("projects_user_slug_active")
      .on(table.userId, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    index("projects_user_last_activity_active")
      .on(table.userId, table.lastActivityAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("projects_user_personal")
      .on(table.userId)
      .where(sql`${table.isPersonal} = true AND ${table.deletedAt} IS NULL`),
  ],
);

export const works = pgTable(
  "works",
  {
    id: idColumn<WorkId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .$type<UserId>()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    index("works_project_updated_active")
      .on(table.projectId, table.updatedAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    index("works_created_by_active")
      .on(table.createdByUserId)
      .where(sql`${table.deletedAt} IS NULL`),
    check("works_visibility_valid", sql`${table.visibility} IN ('private', 'shared')`),
  ],
);

// work_id FK for work-scoped context sources
export const contextSources = pgTable(
  "context_sources",
  {
    id: idColumn<ContextSourceId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "cascade" }),
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
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("context_sources_project_slug")
      .on(table.projectId, table.slug)
      .where(sql`${table.workId} IS NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("context_sources_work_slug")
      .on(table.workId, table.slug)
      .where(sql`${table.workId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index("context_sources_project_sort")
      .on(table.projectId, table.sortOrder)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "context_sources_exactly_one_scope",
      sql`(${table.projectId} IS NOT NULL AND ${table.workId} IS NULL) OR (${table.projectId} IS NULL AND ${table.workId} IS NOT NULL)`,
    ),
    check("context_sources_scope_valid", sql`${table.scope} IN ('project', 'work')`),
    check(
      "context_sources_scope_work_fk",
      sql`${table.scope} = 'project' OR ${table.workId} IS NOT NULL`,
    ),
    check(
      "context_sources_scope_project_fk",
      sql`${table.scope} = 'work' OR ${table.workId} IS NULL`,
    ),
    check(
      "context_sources_adapter_type_valid",
      sql`${table.adapterType} IN ('local', 'google_drive', 'dropbox', 'notion')`,
    ),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: idColumn<FolderId>(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").$type<FolderId>(),
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
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("folders_context_parent_name_active")
      .on(table.contextSourceId, table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("folders_context_root_name_active")
      .on(table.contextSourceId, table.name)
      .where(sql`${table.parentId} IS NULL AND ${table.deletedAt} IS NULL`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: idColumn<DocumentId>(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .$type<FolderId>()
      .references(() => folders.id, {
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
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("documents_context_folder_name_active")
      .on(table.contextSourceId, table.folderId, table.name, table.extension)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("documents_context_root_name_active")
      .on(table.contextSourceId, table.name, table.extension)
      .where(sql`${table.folderId} IS NULL AND ${table.deletedAt} IS NULL`),
    index("documents_markdown_projection_fts").using(
      "gin",
      sql`to_tsvector('simple', ${table.markdownProjection})`,
    ),
    index("documents_markdown_projection_trgm").using(
      "gin",
      sql`${table.markdownProjection} gin_trgm_ops`,
    ),
    index("documents_name_fts").using("gin", sql`to_tsvector('simple', ${table.name})`),
    index("documents_name_trgm").using("gin", sql`${table.name} gin_trgm_ops`),
    check(
      "documents_size_bytes_nonneg",
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    check(
      "documents_file_type_valid",
      sql`${table.fileType} IN ('markdown', 'docx', 'image', 'pdf', 'text')`,
    ),
  ],
);

// folders.parent_id self-FK added in migration SQL
