import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  ProjectSettings,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { WORK_STATUS_MAX_LENGTH } from "@meridian/contracts/works";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
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

export const DOCUMENT_KINDS = {
  content: "content",
  manifest: "manifest",
} as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[keyof typeof DOCUMENT_KINDS];

export function isContentDocumentKind(kind: string | null | undefined): boolean {
  return kind === DOCUMENT_KINDS.content;
}

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
    isPersonal: boolean("is_personal").notNull().default(false),
    defaultBootstrapReady: boolean("default_bootstrap_ready").notNull().default(false),
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
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug"),
    isNoWork: boolean("is_no_work").notNull().default(false),
    goal: text("goal"),
    status: text("status"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    aiWriteMode: text("ai_write_mode").notNull().default("direct"),
    entityRevision: bigint("entity_revision", { mode: "bigint" }).notNull().default(sql`1`),
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
    uniqueIndex("works_project_name_active")
      .on(table.projectId, sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("works_project_slug")
      .on(table.projectId, table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
    uniqueIndex("works_project_no_work_active")
      .on(table.projectId)
      .where(sql`${table.isNoWork} = true AND ${table.deletedAt} IS NULL`),
    check("works_name_nonempty", sql`btrim(${table.name}) <> ''`),
    check(
      "works_no_work_slug",
      sql`(${table.isNoWork} AND ${table.slug} IS NULL) OR (NOT ${table.isNoWork} AND ${table.slug} IS NOT NULL)`,
    ),
    check("works_no_work_not_archived", sql`NOT ${table.isNoWork} OR ${table.archivedAt} IS NULL`),
    check(
      "works_slug_valid",
      sql`${table.slug} IS NULL OR ${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    // Schema SQL needs a literal: interpolating a number generates an unbound $1 in migrations.
    check(
      "works_status_length",
      sql`${table.status} IS NULL OR char_length(${table.status}) <= ${sql.raw(String(WORK_STATUS_MAX_LENGTH))}`,
    ),
    check("works_ai_write_mode_valid", sql`${table.aiWriteMode} IN ('direct', 'draft')`),
    unique("works_project_id_unique").on(table.projectId, table.id),
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
    // Lineage identity is not a thread-row FK: trashing/purging the first chat must not cascade.
    rootThreadId: uuid("root_thread_id").$type<ThreadId>(),
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
    deletedByWorkId: uuid("deleted_by_work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "set null" }),
  },
  (table) => [
    index("context_sources_deleted_by_work_idx")
      .on(table.deletedByWorkId)
      .where(sql`${table.deletedByWorkId} IS NOT NULL`),
    uniqueIndex("context_sources_project_scope_slug")
      .on(table.projectId, table.slug)
      .where(
        sql`${table.workId} IS NULL AND ${table.rootThreadId} IS NULL AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("context_sources_work_slug")
      .on(table.workId, table.slug)
      .where(sql`${table.workId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("context_sources_lineage_slug")
      .on(table.rootThreadId, table.slug)
      .where(sql`${table.rootThreadId} IS NOT NULL`),
    index("context_sources_project_sort")
      .on(table.projectId, table.sortOrder)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "context_sources_exactly_one_scope",
      sql`(${table.scope} = 'project' AND ${table.projectId} IS NOT NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NULL) OR (${table.scope} = 'work' AND ${table.projectId} IS NULL AND ${table.workId} IS NOT NULL AND ${table.rootThreadId} IS NULL) OR (${table.scope} = 'lineage' AND ${table.projectId} IS NOT NULL AND ${table.workId} IS NULL AND ${table.rootThreadId} IS NOT NULL AND ${table.slug} = 'scratch')`,
    ),
    check("context_sources_scope_valid", sql`${table.scope} IN ('project', 'work', 'lineage')`),
    check(
      "context_sources_scope_work_fk",
      sql`${table.scope} <> 'work' OR ${table.workId} IS NOT NULL`,
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
    deletedByWorkId: uuid("deleted_by_work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "set null" }),
  },
  (table) => [
    index("folders_deleted_by_work_idx")
      .on(table.deletedByWorkId)
      .where(sql`${table.deletedByWorkId} IS NOT NULL`),
    index("folders_context_parent_active")
      .on(table.contextSourceId, table.parentId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("folders_context_parent_name_active")
      .on(table.contextSourceId, table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("folders_context_root_name_active")
      .on(table.contextSourceId, table.name)
      .where(sql`${table.parentId} IS NULL AND ${table.deletedAt} IS NULL`),
    // Image path lookups walk deleted folders too, so the active-only indexes miss them.
    index("folders_context_root").on(table.contextSourceId).where(sql`${table.parentId} IS NULL`),
    index("folders_parent").on(table.parentId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: idColumn<DocumentId>(),
    kind: text("kind").$type<DocumentKind>().notNull().default(DOCUMENT_KINDS.content),
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
    locationVersion: bigint("location_version", { mode: "bigint" }).notNull().default(sql`0`),
    markdownProjection: text("markdown_projection").notNull().default(""),
    provisionalName: boolean("provisional_name").notNull().default(false),
    metadata: jsonbDefault("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: softDeleteAt(),
    deletedByWorkId: uuid("deleted_by_work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "set null" }),
  },
  (table) => [
    index("documents_deleted_by_work_idx")
      .on(table.deletedByWorkId)
      .where(sql`${table.deletedByWorkId} IS NOT NULL`),
    index("documents_context_folder_active")
      .on(table.contextSourceId, table.folderId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("documents_context_folder_name_active")
      .on(table.contextSourceId, table.folderId, table.name, table.extension)
      .where(sql`${table.deletedAt} IS NULL AND ${table.kind} = 'content'`),
    uniqueIndex("documents_context_root_name_active")
      .on(table.contextSourceId, table.name, table.extension)
      .where(
        sql`${table.folderId} IS NULL AND ${table.deletedAt} IS NULL AND ${table.kind} = 'content'`,
      ),
    uniqueIndex("documents_manifest_context_active")
      .on(table.contextSourceId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.kind} = 'manifest'`),
    // Image path lookups, deleted images included.
    index("documents_context_images")
      .on(table.contextSourceId)
      .where(sql`${table.fileType} = 'image' AND ${table.kind} = 'content'`),
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
      sql`${table.fileType} IN ('markdown', 'python', 'typescript', 'javascript', 'json', 'shell', 'yaml', 'text', 'csv', 'notebook', 'pdf', 'png', 'jpg', 'svg', 'docx', 'image', 'binary')`,
    ),
    check("documents_kind_valid", sql`${table.kind} IN ('content', 'manifest')`),
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
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "cascade" }),
    contextSourceId: uuid("context_source_id")
      .$type<ContextSourceId>()
      .notNull()
      .references(() => contextSources.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").$type<DocumentId>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    byteDigest: text("byte_digest").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    finalPath: text("final_path").notNull(),
    objectKey: text("object_key").notNull(),
    fileType: text("file_type").notNull(),
    canonicalUri: text("canonical_uri").notNull(),
    locationRevision: uuid("location_revision").notNull(),
    state: text("state").notNull().default("reserved"),
    storageUrl: text("storage_url"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("upload_intakes_project_intake_unique").on(table.projectId, table.intakeId),
    unique("upload_intakes_document_unique").on(table.documentId),
    uniqueIndex("upload_intakes_source_path_live")
      .on(table.contextSourceId, sql`lower(${table.finalPath})`)
      .where(sql`${table.state} <> 'deleted'`),
    check(
      "upload_intakes_state_valid",
      sql`${table.state} IN ('reserved', 'object_stored', 'finalized', 'deleted')`,
    ),
    check("upload_intakes_digest_valid", sql`${table.byteDigest} ~ '^[0-9a-f]{64}$'`),
  ],
);

export function contentDocumentPredicate(table: Pick<typeof documents, "kind"> = documents) {
  return sql`${table.kind} = ${DOCUMENT_KINDS.content}`;
}

export function contentDocumentKindSql(alias = "documents") {
  return sql`${sql.raw(alias)}.kind = ${DOCUMENT_KINDS.content}`;
}

// folders.parent_id self-FK added in migration SQL

/** Vacated document locations point directly to identity, never another path. */
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
    // Full paths can exceed PostgreSQL B-tree tuple limits. Exact equality is
    // rechecked by the hash index; namespace locks own replacement uniqueness.
    index("document_previous_locations_path").using("hash", table.path),
    index("document_previous_locations_source").on(table.contextSourceId),
    index("document_previous_locations_document").on(table.documentId),
  ],
);

/**
 * Outgoing links of a holder, one row per link key, from the same durable cut as the projection.
 * A hint from a certified cut, not link authority: target and ahead columns carry no FKs.
 */
export const documentLinks = pgTable(
  "document_links",
  {
    sourceDocumentId: uuid("source_document_id")
      .$type<DocumentId>()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** `doc:<id>`, `ahead:<uuid>`, `asset:<id>`, or the contextual href itself. */
    linkKey: text("link_key").notNull(),
    /** `doc:` and `asset:` keys. */
    targetDocumentId: uuid("target_document_id").$type<DocumentId>(),
    aheadId: uuid("ahead_id"),
    /** Decoded canonical address for ref keys (registration recovery); null for contextual. */
    address: text("address"),
    occurrences: integer("occurrences").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceDocumentId, table.linkKey] }),
    index("document_links_target_document").on(table.targetDocumentId),
    index("document_links_ahead").on(table.aheadId),
  ],
);

/**
 * Durable identity for a link written before its target document arrived.
 * Settlement is permanent: every document that arrived, finalized uploads
 * included, leaves through the soft-delete lifecycle and keeps its row, so a
 * settled ref answers gone and never captures a later occupant. No product
 * path hard-deletes a document (an upload reservation that never finalized
 * has no document row); SET NULL only lets an out-of-band row removal unsettle
 * a ref instead of failing.
 */
export const linkAheadRefs = pgTable(
  "link_ahead_refs",
  {
    aheadId: uuid("ahead_id").primaryKey(),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scheme: text("scheme").notNull(),
    workId: uuid("work_id")
      .$type<WorkId>()
      .references(() => works.id, { onDelete: "cascade" }),
    rootThreadId: uuid("root_thread_id"),
    path: text("path").notNull(),
    settledDocumentId: uuid("settled_document_id")
      .$type<DocumentId>()
      .references(() => documents.id, { onDelete: "set null" }),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    // A decoded path has no byte bound, so the key carries its md5; lookups recheck the
    // exact path (Postgres B-tree tuples cap near 2.7 kB).
    index("link_ahead_refs_owner_unsettled")
      .on(table.projectId, table.scheme, table.workId, table.rootThreadId, sql`md5(${table.path})`)
      .where(sql`${table.settledDocumentId} IS NULL`),
    index("link_ahead_refs_settled_document").on(table.settledDocumentId),
  ],
);
