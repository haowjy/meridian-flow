import type {
  ContextSourceId,
  DocumentId,
  ProjectId,
  ProjectSettings,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { type AiWriteMode, WORK_STATUS_MAX_LENGTH } from "@meridian/contracts/works";
import { COLLAB_SCHEMA_VERSION, packCollabSchemaVersion } from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, jsonbDefault, softDeleteAt, updatedAt } from "./_shared";
import { users } from "./users";

export const projects = pgTable(
  "projects",
  {
    id: idColumn<ProjectId>(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    treeListId: uuid("tree_list_id")
      .$type<DocumentId>()
      .notNull()
      .unique()
      .default(sql`gen_random_uuid()`),
    systemPrompt: text("system_prompt"),
    settings: jsonbDefault("settings").$type<ProjectSettings>(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("projects_user_slug").on(table.userId, table.slug),
    index("projects_user_last_activity_active")
      .on(table.userId, table.lastActivityAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),
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
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    handle: text("handle"),
    isNoWork: boolean("is_no_work").notNull().default(false),
    goal: text("goal"),
    status: text("status"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    defaultAiWriteMode: text("default_ai_write_mode")
      .$type<AiWriteMode>()
      .notNull()
      .default("direct"),
    entityRevision: bigint("entity_revision", { mode: "bigint" }).notNull().default(sql`1`),
    pendingDocumentCount: integer("pending_document_count").notNull().default(0),
    pendingFolderCount: integer("pending_folder_count").notNull().default(0),
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
    uniqueIndex("works_project_handle")
      .on(table.projectId, table.handle)
      .where(sql`${table.handle} IS NOT NULL`),
    uniqueIndex("works_project_no_work_active")
      .on(table.projectId)
      .where(sql`${table.isNoWork} = true AND ${table.deletedAt} IS NULL`),
    check("works_name_nonempty", sql`btrim(${table.name}) <> ''`),
    check(
      "works_no_work_handle",
      sql`(${table.isNoWork} AND ${table.handle} IS NULL) OR (NOT ${table.isNoWork} AND ${table.handle} IS NOT NULL)`,
    ),
    check("works_no_work_not_archived", sql`NOT ${table.isNoWork} OR ${table.archivedAt} IS NULL`),
    check("works_handle_valid", sql`${table.handle} IS NULL OR ${table.handle} ~ '^w[1-9][0-9]*$'`),
    // Schema SQL needs a literal because interpolating a number creates an unbound $1 in migrations
    check(
      "works_status_length",
      sql`${table.status} IS NULL OR char_length(${table.status}) <= ${sql.raw(String(WORK_STATUS_MAX_LENGTH))}`,
    ),
    check(
      "works_default_ai_write_mode_valid",
      sql`${table.defaultAiWriteMode} IN ('direct', 'draft')`,
    ),
    unique("works_project_id_unique").on(table.projectId, table.id),
  ],
);

export const contextSources = pgTable(
  "context_sources",
  {
    id: idColumn<ContextSourceId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "cascade" }),
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "cascade" }),
    // RootThreadId has no thread FK; purging the first chat must not cascade its Scratch
    rootThreadId: uuid("root_thread_id").$type<ThreadId>(),
    // ChatThreadId has no thread FK; purging the chat must not cascade its uploads source
    chatThreadId: uuid("chat_thread_id").$type<ThreadId>(),
    slug: text("slug").notNull(),
    scope: text("scope").notNull().default("project"),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
  },
  (table) => [
    uniqueIndex("context_sources_project_scope_slug")
      .on(table.projectId, table.slug)
      .where(
        sql`${table.workId} IS NULL AND ${table.rootThreadId} IS NULL AND ${table.chatThreadId} IS NULL AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("context_sources_work_slug")
      .on(table.workId, table.slug)
      .where(sql`${table.workId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("context_sources_lineage_slug")
      .on(table.rootThreadId, table.slug)
      .where(sql`${table.rootThreadId} IS NOT NULL`),
    uniqueIndex("context_sources_chat_slug")
      .on(table.chatThreadId, table.slug)
      .where(sql`${table.chatThreadId} IS NOT NULL`),
    uniqueIndex("context_sources_account_slug")
      .on(table.userId, table.slug)
      .where(sql`${table.scope} = 'account' AND ${table.deletedAt} IS NULL`),
    index("context_sources_project_sort")
      .on(table.projectId, table.sortOrder)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "context_sources_exactly_one_scope",
      sql`(${table.scope} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.userId} IS NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NULL AND ${table.chatThreadId} IS NULL) OR (${table.scope} = 'work' AND ${table.projectId} IS NULL AND ${table.userId} IS NULL AND ${table.workId} IS NOT NULL AND ${table.rootThreadId} IS NULL AND ${table.chatThreadId} IS NULL) OR (${table.scope} = 'lineage' AND ${table.projectId} IS NOT NULL AND ${table.userId} IS NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NOT NULL AND ${table.chatThreadId} IS NULL AND ${table.slug} = 'scratch') OR (${table.scope} = 'chat' AND ${table.projectId} IS NOT NULL AND ${table.userId} IS NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NULL AND ${table.chatThreadId} IS NOT NULL AND ${table.slug} = 'uploads') OR (${table.scope} = 'account' AND ${table.userId} IS NOT NULL AND ${table.projectId} IS NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NULL AND ${table.chatThreadId} IS NULL AND ${table.slug} = 'user')`,
    ),
    check(
      "context_sources_uploads_chat_only",
      sql`${table.slug} <> 'uploads' OR ${table.scope} = 'chat'`,
    ),
    check(
      "context_sources_user_account_only",
      sql`${table.slug} <> 'user' OR ${table.scope} = 'account'`,
    ),
    check(
      "context_sources_scope_valid",
      sql`${table.scope} IN ('project', 'work', 'lineage', 'chat', 'account')`,
    ),
    check(
      "context_sources_scope_work_fk",
      sql`${table.scope} <> 'work' OR ${table.workId} IS NOT NULL`,
    ),
    check(
      "context_sources_scope_project_fk",
      sql`${table.scope} = 'work' OR ${table.workId} IS NULL`,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: idColumn<DocumentId>(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "cascade" }),
    storageUrl: text("storage_url"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    hasPreview: boolean("has_preview").notNull().default(false),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: "date" }),
    inNoViewSince: timestamp("in_no_view_since", { withTimezone: true, mode: "date" }),
    schemaVersion: integer("schema_version")
      .notNull()
      .default(packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)),
    contentSeq: bigint("content_seq", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (table) => [
    check(
      "documents_stored_mime_type",
      sql`${table.storageUrl} IS NULL OR ${table.mimeType} IS NOT NULL`,
    ),
    check(
      "documents_size_bytes_nonneg",
      sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`,
    ),
    check("documents_one_owner", sql`num_nonnulls(${table.projectId}, ${table.userId}) = 1`),
    index("documents_project").on(table.projectId),
    index("documents_user").on(table.userId),
    index("documents_in_no_view")
      .on(table.inNoViewSince)
      .where(sql`${table.inNoViewSince} IS NOT NULL AND ${table.contentPurgedAt} IS NULL`),
  ],
);

export const uploadIntakes = pgTable(
  "upload_intakes",
  {
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    intakeId: text("intake_id").notNull(),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // OwnerThreadId has no thread FK; the chat row may not exist at attach and its purge must not cascade
    ownerThreadId: uuid("owner_thread_id").$type<ThreadId>(),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    finalPath: text("final_path"),
    objectKey: text("object_key").notNull(),
    fileType: text("file_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    state: text("state").notNull().default("reserved"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("upload_intakes_project_intake_unique").on(table.projectId, table.intakeId),
    unique("upload_intakes_document_unique").on(table.documentId),
    check(
      "upload_intakes_state_valid",
      sql`${table.state} IN ('reserved', 'object_stored', 'finalized')`,
    ),
    index("upload_intakes_owner_thread")
      .on(table.ownerThreadId)
      .where(sql`${table.ownerThreadId} IS NOT NULL`),
    index("upload_intakes_open_updated")
      .on(table.updatedAt)
      .where(sql`${table.state} IN ('reserved', 'object_stored')`),
  ],
);

export const documentPreviousLocations = pgTable(
  "document_previous_locations",
  {
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    documentId: uuid("document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    // Hash-index unbounded paths and recheck exact equality; namespace locks own replacement uniqueness
    index("document_previous_locations_path").using("hash", table.path),
    index("document_previous_locations_source").on(table.contextSourceId),
    index("document_previous_locations_document").on(table.documentId),
  ],
);

export const documentLinks = pgTable(
  "document_links",
  {
    sourceDocumentId: uuid("source_document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    linkKey: text("link_key").notNull(),
    targetDocumentId: uuid("target_document_id").$type<DocumentId>(),
    aheadId: uuid("ahead_id"),
    address: text("address"),
    occurrences: integer("occurrences").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceDocumentId, table.linkKey] }),
    index("document_links_target_document").on(table.targetDocumentId),
    index("document_links_ahead").on(table.aheadId),
  ],
);

export const linkAheadRefs = pgTable(
  "link_ahead_refs",
  {
    aheadId: uuid("ahead_id").primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "cascade" }),
    scheme: text("scheme").notNull(),
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "cascade" }),
    rootThreadId: uuid("root_thread_id"),
    chatThreadId: uuid("chat_thread_id"),
    path: text("path").notNull(),
    settledDocumentId: uuid("settled_document_id")
      .$type<DocumentId>()
      .references(() => documents.id, { onDelete: "set null" }),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    // Index md5 of unbounded paths and recheck exact equality; Postgres B-tree tuples cap near 2.7 kB
    index("link_ahead_refs_owner_unsettled")
      .on(
        table.projectId,
        table.userId,
        table.scheme,
        table.workId,
        table.rootThreadId,
        table.chatThreadId,
        sql`md5(${table.path})`,
      )
      .where(sql`${table.settledDocumentId} IS NULL`),
    index("link_ahead_refs_settled_document").on(table.settledDocumentId),
    check("link_ahead_refs_one_holder", sql`num_nonnulls(${table.projectId}, ${table.userId}) = 1`),
  ],
);
