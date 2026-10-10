/**
 * The tree view's SQL: the only file that reads the hidden predicate (rule 1).
 *
 * Builds the live and draft relations every reader selects from, and the identity rows
 * the tree view decides from. Readers compose these through `tree-view.ts`; nothing else
 * reads `documents.hidden` or `folders.hidden`.
 *
 * Live is the predicate over the table, so Postgres flattens it into the reader's query.
 * A draft is a `UNION ALL`: live rows the draft says nothing about, plus the draft's
 * change rows at the draft's location. Folders have no change rows yet, so a draft's
 * folders are the live ones plus the hidden ones its documents sit under.
 *
 * `kind = 'content'` keeps the live manifest row out of every relation until lane M
 * deletes the manifest and the column.
 */
import type { ContextSourceId, DocumentId, DraftId, FolderId, WorkId } from "@meridian/contracts";
import type { JsonObject } from "@meridian/contracts/threads";
import { getTableColumns, type SQL, Subquery, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { SelectionProxyHandler } from "drizzle-orm/selection-proxy";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeView } from "./tree-view.js";

// The relations' column shapes. Not schema tables: they type and decode the subqueries
// below, and every reference to them renders qualified by the subquery's alias.
const visibleDocumentShape = pgTable("visible_documents", {
  id: uuid("id").$type<DocumentId>().notNull(),
  contextSourceId: uuid("context_source_id").$type<ContextSourceId>().notNull(),
  folderId: uuid("folder_id").$type<FolderId>(),
  name: text("name").notNull(),
  extension: text("extension").notNull(),
  fileType: text("file_type").notNull(),
  storageUrl: text("storage_url"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
  provisionalName: boolean("provisional_name").notNull(),
  locationVersion: bigint("location_version", { mode: "bigint" }).notNull(),
  hidden: boolean("hidden").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  /** The draft sets this row's location (always false in the live view). */
  draftLocated: boolean("draft_located").notNull(),
});

const visibleFolderShape = pgTable("visible_folders", {
  id: uuid("id").$type<FolderId>().notNull(),
  contextSourceId: uuid("context_source_id").$type<ContextSourceId>().notNull(),
  parentId: uuid("parent_id").$type<FolderId>(),
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull(),
  hidden: boolean("hidden").notNull(),
  locationVersion: bigint("location_version", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const visibleDocumentColumns = getTableColumns(visibleDocumentShape);
const visibleFolderColumns = getTableColumns(visibleFolderShape);

export type VisibleDocumentsSubquery = Subquery<
  "visible_documents",
  typeof visibleDocumentColumns
> &
  typeof visibleDocumentColumns;
export type VisibleFoldersSubquery = Subquery<"visible_folders", typeof visibleFolderColumns> &
  typeof visibleFolderColumns;

/** A typed `FROM` item over raw SQL, proxied the way Drizzle's own `.as()` proxies subqueries. */
function subquery<TAlias extends string, TColumns extends Record<string, unknown>>(
  query: SQL,
  columns: TColumns,
  alias: TAlias,
): Subquery<TAlias, TColumns> & TColumns {
  return new Proxy(
    new Subquery(query, columns, alias),
    new SelectionProxyHandler({ alias, sqlAliasedBehavior: "alias", sqlBehavior: "error" }),
  ) as unknown as Subquery<TAlias, TColumns> & TColumns;
}

const documentTail = sql.raw(
  "d.file_type, d.storage_url, d.mime_type, d.size_bytes, d.metadata, d.provisional_name, " +
    "d.location_version, d.hidden, d.created_at, d.updated_at",
);
const folderColumns = sql.raw(
  "f.id, f.context_source_id, f.parent_id, f.name, f.description, f.sort_order, f.hidden, " +
    "f.location_version, f.created_at, f.updated_at",
);

/** The predicate: a document row in the live tree. */
const liveDocument = sql.raw("d.deleted_at IS NULL AND NOT d.hidden AND d.kind = 'content'");
/** A document the draft has a change row for, in the draft's view (PR 3 adds `AND NOT c.deleted`). */
const draftDocument = sql.raw(
  "d.deleted_at IS NULL AND d.kind = 'content' AND (NOT d.hidden OR c.created)",
);
/** Where the draft has the document: its own location when it sets one, else the row's. */
const draftFolderId = sql.raw(
  "CASE WHEN c.context_source_id IS NULL THEN d.folder_id ELSE c.parent_folder_id END",
);

function documentsQuery(view: TreeView): SQL {
  const live = sql`SELECT d.id, d.context_source_id, d.folder_id, d.name, d.extension, ${documentTail},
      false AS draft_located
    FROM documents d WHERE ${liveDocument}`;
  if (view.kind === "live") return live;
  const draftId = view.draftId;
  return sql`${live}
      AND NOT EXISTS (SELECT 1 FROM draft_tree_changes c
        WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND c.node_id = d.id)
    UNION ALL
    SELECT d.id, COALESCE(c.context_source_id, d.context_source_id), ${draftFolderId},
      COALESCE(c.name, d.name), COALESCE(c.extension, d.extension), ${documentTail},
      c.context_source_id IS NOT NULL
    FROM draft_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND ${draftDocument}`;
}

function foldersQuery(view: TreeView): SQL {
  const live = sql`SELECT ${folderColumns} FROM folders f
    WHERE f.deleted_at IS NULL AND NOT f.hidden`;
  if (view.kind === "live") return live;
  const draftId = view.draftId;
  // Hidden folders the draft's view places something under, and their ancestors (TM
  // invariant 1). A second branch rather than an OR, so live lookups keep their indexes.
  return sql`${live}
    UNION ALL
    SELECT ${folderColumns} FROM folders f
    WHERE f.deleted_at IS NULL AND f.hidden AND f.id IN (
      WITH RECURSIVE used(id) AS (
        SELECT ${draftFolderId}
        FROM draft_tree_changes c JOIN documents d ON d.id = c.node_id
        WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND ${draftDocument}
          AND ${draftFolderId} IS NOT NULL
        UNION
        SELECT c.node_id FROM draft_tree_changes c
        WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'folder' AND c.created
        UNION
        SELECT f2.parent_id FROM folders f2 JOIN used u ON f2.id = u.id
        WHERE f2.parent_id IS NOT NULL
      )
      SELECT id FROM used)`;
}

/** Documents visible in this view, at the view's location (alias "visible_documents"). */
export function visibleDocuments(view: TreeView): VisibleDocumentsSubquery {
  return subquery(documentsQuery(view), visibleDocumentColumns, "visible_documents");
}

/** Folders visible in this view (alias "visible_folders"). */
export function visibleFolders(view: TreeView): VisibleFoldersSubquery {
  return subquery(foldersQuery(view), visibleFolderColumns, "visible_folders");
}

/** The documents relation for raw-SQL readers: `sql\`… FROM ${visibleDocumentsSql(view)} d …\``. */
export function visibleDocumentsSql(view: TreeView): SQL {
  return sql`(${documentsQuery(view)})`;
}

/** The folders relation for raw-SQL readers. */
export function visibleFoldersSql(view: TreeView): SQL {
  return sql`(${foldersQuery(view)})`;
}

/** A document row by id, whatever its visibility: what the view decides identity from. */
export type DocumentIdentityRow = {
  id: DocumentId;
  hidden: boolean;
  deleted: boolean;
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  name: string;
  extension: string;
  fileType: string;
  storageUrl: string | null;
  locationVersion: bigint;
};

type RawIdentityRow = {
  id: string;
  hidden: boolean;
  deleted: boolean;
  context_source_id: string;
  folder_id: string | null;
  name: string;
  extension: string;
  file_type: string;
  storage_url: string | null;
  location_version: string;
};

function identityRow(row: RawIdentityRow): DocumentIdentityRow {
  return {
    id: row.id as DocumentId,
    hidden: row.hidden,
    deleted: row.deleted,
    contextSourceId: row.context_source_id as ContextSourceId,
    folderId: row.folder_id as FolderId | null,
    name: row.name,
    extension: row.extension,
    fileType: row.file_type,
    storageUrl: row.storage_url,
    locationVersion: BigInt(row.location_version),
  };
}

const identityColumns = sql.raw(
  "d.id::text AS id, d.hidden, d.deleted_at IS NOT NULL AS deleted, " +
    "d.context_source_id::text AS context_source_id, d.folder_id::text AS folder_id, d.name, " +
    "d.extension, d.file_type, d.storage_url, d.location_version::text AS location_version",
);

export async function loadDocumentIdentityRows(
  db: DrizzleDb,
  ids: readonly DocumentId[],
): Promise<DocumentIdentityRow[]> {
  if (ids.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<RawIdentityRow>(sql`
    SELECT ${identityColumns} FROM documents d
    WHERE d.kind = 'content' AND d.id IN (${uuidList(ids)})`);
  return rows.map(identityRow);
}

/** Where a draft has a node: null fields when the draft sets no location. */
export type DraftLocation = {
  contextSourceId: ContextSourceId | null;
  parentFolderId: FolderId | null;
  name: string | null;
  extension: string | null;
};

/** One active draft that created a document, oldest draft first per document. */
export type DraftUseRow = DraftLocation & {
  documentId: DocumentId;
  draftId: DraftId;
  originWorkId: WorkId | null;
  draftCreatedAt: Date;
};

export async function loadActiveDraftUses(
  db: DrizzleDb,
  documentIds: readonly DocumentId[],
): Promise<DraftUseRow[]> {
  if (documentIds.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{
    document_id: string;
    draft_id: string;
    origin_work_id: string | null;
    draft_created_ms: number;
    context_source_id: string | null;
    parent_folder_id: string | null;
    name: string | null;
    extension: string | null;
  }>(sql`
    SELECT c.node_id::text AS document_id, r.id::text AS draft_id,
      r.origin_work_id::text AS origin_work_id,
      (extract(epoch FROM r.created_at) * 1000)::float8 AS draft_created_ms,
      c.context_source_id::text AS context_source_id,
      c.parent_folder_id::text AS parent_folder_id, c.name, c.extension
    FROM draft_tree_changes c JOIN drafts r ON r.id = c.draft_id
    WHERE c.node_kind = 'document' AND c.node_id IN (${uuidList(documentIds)})
      AND c.created AND r.status = 'active'
    ORDER BY c.node_id, r.created_at, r.id`);
  return rows.map((row) => ({
    documentId: row.document_id as DocumentId,
    draftId: row.draft_id as DraftId,
    originWorkId: row.origin_work_id as WorkId | null,
    draftCreatedAt: new Date(Number(row.draft_created_ms)),
    contextSourceId: row.context_source_id as ContextSourceId | null,
    parentFolderId: row.parent_folder_id as FolderId | null,
    name: row.name,
    extension: row.extension,
  }));
}

/** A document the draft created, with the draft's location and the row. */
export type DraftCreatedRow = { draft: DraftLocation; row: DocumentIdentityRow };

export async function loadDraftCreatedDocuments(
  db: DrizzleDb,
  draftId: DraftId,
): Promise<DraftCreatedRow[]> {
  const rows = await currentDrizzleDb(db).execute<
    RawIdentityRow & {
      c_context_source_id: string | null;
      c_parent_folder_id: string | null;
      c_name: string | null;
      c_extension: string | null;
    }
  >(sql`
    SELECT ${identityColumns},
      c.context_source_id::text AS c_context_source_id,
      c.parent_folder_id::text AS c_parent_folder_id,
      c.name AS c_name, c.extension AS c_extension
    FROM draft_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND c.created
      AND d.kind = 'content'
    ORDER BY c.created_at, c.node_id`);
  return rows.map((row) => ({
    row: identityRow(row),
    draft: {
      contextSourceId: row.c_context_source_id as ContextSourceId | null,
      parentFolderId: row.c_parent_folder_id as FolderId | null,
      name: row.c_name,
      extension: row.c_extension,
    },
  }));
}

/** The `hidden` column of a documents alias, for the address loader's identity rows. */
export function documentHiddenSql(alias: string): SQL {
  return sql.raw(`${alias}.hidden`);
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
