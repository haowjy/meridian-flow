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

/**
 * Lookup positions joined into each branch, so a path question stays bounded by the path
 * indexes and D's own rows instead of filtering the whole relation. `parent` matches a
 * branch's parent column: root slots by `IS NULL`, the rest by equality.
 */
type SlotMatch = { values: SQL; parent: (column: SQL) => SQL };

function slotted(match: SlotMatch | undefined, columns: string): SQL {
  return match ? sql`(VALUES ${match.values}) AS p(${sql.raw(columns)}), ` : sql``;
}

/** The slot's position on one alias's location columns. */
function at(
  match: SlotMatch | undefined,
  location: Record<"source" | "parent" | "name", string>,
  extension?: string,
): SQL {
  if (!match) return sql``;
  return sql` AND ${sql.raw(location.source)} = p.source_id AND ${sql.raw(location.name)} = p.name${
    extension ? sql` AND ${sql.raw(extension)} = p.extension` : sql``
  } AND ${match.parent(sql.raw(location.parent))}`;
}

const rowLocation = { source: "d.context_source_id", parent: "d.folder_id", name: "d.name" };
const draftLocation = {
  source: "c.context_source_id",
  parent: "c.parent_folder_id",
  name: "c.name",
};

/**
 * Live rows D says nothing about, D's rows at D's location, and D's rows that set no
 * location at the row's. The last two are separate branches projecting plain columns, so
 * a path predicate reaches an index on either side.
 */
function documentsQuery(view: TreeView, match?: SlotMatch): SQL {
  const slots = slotted(match, "key, source_id, parent_id, name, extension");
  const select = (location: string, located: boolean) =>
    match
      ? sql`SELECT p.key, d.id`
      : sql`SELECT d.id, ${sql.raw(location)}, ${documentTail}, ${sql.raw(String(located))} AS draft_located`;
  const rowColumns = "d.context_source_id, d.folder_id, d.name, d.extension";
  const live = sql`${select(rowColumns, false)}
    FROM ${slots}documents d WHERE ${liveDocument}${at(match, rowLocation, "d.extension")}`;
  if (view.kind === "live") return live;
  const draftId = view.draftId;
  const draftRows = sql`c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND ${draftDocument}`;
  return sql`${live}
      AND NOT EXISTS (SELECT 1 FROM draft_tree_changes c
        WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND c.node_id = d.id)
    UNION ALL
    ${select("c.context_source_id, c.parent_folder_id, c.name, c.extension", true)}
    FROM ${slots}draft_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE ${draftRows} AND c.context_source_id IS NOT NULL${at(match, draftLocation, "c.extension")}
    UNION ALL
    ${select(rowColumns, false)}
    FROM ${slots}draft_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE ${draftRows} AND c.context_source_id IS NULL${at(match, rowLocation, "d.extension")}`;
}

/**
 * Hidden folders D's view places something under, and their ancestors (TM invariant 1),
 * seeded from D's change rows: each row's document is one primary-key probe.
 */
function usedHiddenFolderIds(draftId: DraftId): SQL {
  return sql`
    WITH RECURSIVE used(id) AS (
      SELECT placed.folder_id FROM draft_tree_changes c
      CROSS JOIN LATERAL (
        SELECT ${draftFolderId} AS folder_id FROM documents d
        WHERE d.id = c.node_id AND ${draftDocument} OFFSET 0
      ) placed
      WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document'
        AND placed.folder_id IS NOT NULL
      UNION
      SELECT c.node_id FROM draft_tree_changes c
      WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'folder' AND c.created
      UNION
      SELECT f2.parent_id FROM folders f2 JOIN used u ON f2.id = u.id
      WHERE f2.parent_id IS NOT NULL
    )
    SELECT id FROM used`;
}

function foldersQuery(view: TreeView, match?: SlotMatch): SQL {
  const slots = slotted(match, "key, source_id, parent_id, name");
  const select = match ? sql`SELECT p.key, f.id` : sql`SELECT ${folderColumns}`;
  const position = at(match, {
    source: "f.context_source_id",
    parent: "f.parent_id",
    name: "f.name",
  });
  const live = sql`${select} FROM ${slots}folders f
    WHERE f.deleted_at IS NULL AND NOT f.hidden${position}`;
  if (view.kind === "live") return live;
  // A second branch rather than an OR, so live lookups keep their indexes.
  return sql`${live}
    UNION ALL
    ${select} FROM ${slots}folders f
    WHERE f.deleted_at IS NULL AND f.hidden${position}
      AND f.id IN (${usedHiddenFolderIds(view.draftId)})`;
}

/** One lookup position: a name under a parent folder (null: the source root). */
export type PathSlot = {
  key: number;
  sourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
};

/** Ids of the documents visible in this view at each slot, by slot key. */
export async function loadDocumentIdsAt(
  db: DrizzleDb,
  view: TreeView,
  slots: readonly (PathSlot & { extension: string })[],
): Promise<{ key: number; id: DocumentId }[]> {
  if (slots.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{ key: number; id: string }>(
    bySlotParent(
      slots,
      (match) => documentsQuery(view, match),
      (slot) => sql`, ${slot.extension}::text`,
    ),
  );
  return rows.map((row) => ({ key: Number(row.key), id: row.id as DocumentId }));
}

/** Ids of the folders visible in this view at each slot, by slot key. */
export async function loadFolderIdsAt(
  db: DrizzleDb,
  view: TreeView,
  slots: readonly PathSlot[],
): Promise<{ key: number; id: FolderId }[]> {
  if (slots.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{ key: number; id: string }>(
    bySlotParent(slots, (match) => foldersQuery(view, match)),
  );
  return rows.map((row) => ({ key: Number(row.key), id: row.id as FolderId }));
}

/** One statement over slot VALUES, root slots and nested ones as separate halves. */
function bySlotParent<S extends PathSlot>(
  slots: readonly S[],
  query: (match: SlotMatch) => SQL,
  extra: (slot: S) => SQL = () => sql``,
): SQL {
  const values = (group: readonly S[]) =>
    sql.join(
      group.map(
        (slot) =>
          sql`(${slot.key}::int, ${slot.sourceId}::uuid, ${slot.parentId}::uuid, ${slot.name}::text${extra(slot)})`,
      ),
      sql`, `,
    );
  const root = slots.filter((slot) => slot.parentId === null);
  const nested = slots.filter((slot) => slot.parentId !== null);
  return sql.join(
    [
      ...(root.length > 0
        ? [query({ values: values(root), parent: (column) => sql`${column} IS NULL` })]
        : []),
      ...(nested.length > 0
        ? [query({ values: values(nested), parent: (column) => sql`${column} = p.parent_id` })]
        : []),
    ],
    sql` UNION ALL `,
  );
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
    FROM draft_tree_changes c
    CROSS JOIN LATERAL (
      SELECT * FROM documents d WHERE d.id = c.node_id AND d.kind = 'content' OFFSET 0
    ) d
    WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND c.created
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
