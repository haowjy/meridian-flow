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
 */
import type { ContextSourceId, DocumentId, DraftId, FolderId, WorkId } from "@meridian/contracts";
import { folderDocumentName, renderFilename } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import { documents, folders } from "@meridian/database/schema";
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
import { BINARY_FILE_TYPES } from "../adapters/catalog-file-mapper.js";
import type { NodeRef, TreeView } from "./tree-view.js";

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
const liveDocument = sql.raw("d.deleted_at IS NULL AND NOT d.hidden");
/** A hidden document the draft created, in the draft's view (PR 3 adds `AND NOT c.deleted`). */
const draftDocument = sql.raw("d.deleted_at IS NULL AND d.hidden AND c.created");

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

/**
 * Live rows, and the hidden documents D created. Both sit at their row's location (a draft's
 * create is a real hidden row), as separate branches so a path predicate reaches an index.
 */
function documentsQuery(view: TreeView, match?: SlotMatch): SQL {
  const slots = slotted(match, "key, source_id, parent_id, name, extension");
  const select = match
    ? sql`SELECT p.key, d.id`
    : sql`SELECT d.id, d.context_source_id, d.folder_id, d.name, d.extension, ${documentTail}`;
  const live = sql`${select}
    FROM ${slots}documents d WHERE ${liveDocument}${at(match, rowLocation, "d.extension")}`;
  if (view.kind === "live") return live;
  return sql`${live}
    UNION ALL
    ${select}
    FROM ${slots}draft_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE c.draft_id = ${view.draftId}::uuid AND c.node_kind = 'document' AND ${draftDocument}${at(match, rowLocation, "d.extension")}`;
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
        SELECT d.folder_id AS folder_id FROM documents d
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
    WHERE d.id IN (${uuidList(ids)})`);
  return rows.map(identityRow);
}

/** One active draft that created a document, oldest draft first per document. */
export type DraftUseRow = {
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
  }>(sql`
    SELECT c.node_id::text AS document_id, r.id::text AS draft_id,
      r.origin_work_id::text AS origin_work_id,
      (extract(epoch FROM r.created_at) * 1000)::float8 AS draft_created_ms
    FROM draft_tree_changes c JOIN drafts r ON r.id = c.draft_id
    WHERE c.node_kind = 'document' AND c.node_id IN (${uuidList(documentIds)})
      AND c.created AND r.status = 'active'
    ORDER BY c.node_id, r.created_at, r.id`);
  return rows.map((row) => ({
    documentId: row.document_id as DocumentId,
    draftId: row.draft_id as DraftId,
    originWorkId: row.origin_work_id as WorkId | null,
    draftCreatedAt: new Date(Number(row.draft_created_ms)),
  }));
}

export async function loadDraftCreatedDocuments(
  db: DrizzleDb,
  draftId: DraftId,
  only?: readonly string[],
): Promise<DocumentIdentityRow[]> {
  if (only?.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<RawIdentityRow>(sql`
    SELECT ${identityColumns}
    FROM draft_tree_changes c
    CROSS JOIN LATERAL (
      SELECT * FROM documents d WHERE d.id = c.node_id OFFSET 0
    ) d
    WHERE c.draft_id = ${draftId}::uuid AND c.node_kind = 'document' AND c.created
      ${only ? sql`AND c.node_id IN (${uuidList(only)})` : sql``}
    ORDER BY c.created_at, c.node_id`);
  return rows.map(identityRow);
}

/** The `hidden` column of a documents alias, for the address loader's identity rows. */
/**
 * A Work's context rows as its restore would bring them back, rendered for the shared
 * document and folder namespace: what is live now and what the Work's delete took
 * (`arriving`). Hidden rows are a draft's and stay hidden through a restore (F11).
 */
export async function loadWorkRestoreNamespaceRows(
  db: DrizzleDb,
  workId: string,
): Promise<
  {
    source: string;
    parent: string | null;
    name: string;
    kind: "file" | "folder";
    arriving: boolean;
  }[]
> {
  return currentDrizzleDb(db).execute(sql`
    SELECT d.context_source_id AS source, d.folder_id AS parent,
      d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END AS name,
      'file' AS kind, coalesce(d.deleted_by_work_id = ${workId}::uuid, false) AS arriving
    FROM documents d WHERE NOT d.hidden
      AND d.context_source_id IN (SELECT id FROM context_sources WHERE work_id = ${workId}::uuid)
      AND (d.deleted_at IS NULL OR d.deleted_by_work_id = ${workId}::uuid)
    UNION ALL
    SELECT f.context_source_id, f.parent_id, f.name, 'folder',
      coalesce(f.deleted_by_work_id = ${workId}::uuid, false)
    FROM folders f WHERE NOT f.hidden
      AND f.context_source_id IN (SELECT id FROM context_sources WHERE work_id = ${workId}::uuid)
      AND (f.deleted_at IS NULL OR f.deleted_by_work_id = ${workId}::uuid)
  `);
}

export function documentHiddenSql(alias: string): SQL {
  return sql.raw(`${alias}.hidden`);
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * Diagnostics extend the canonical selection with formerly live lifecycle/malformed
 * identities only. Placement comes from the same branches as visibleDocuments;
 * hidden tombstones never enter either arm, even with a stale draft change row.
 */
export function identityDocuments(view: TreeView) {
  const columns = getTableColumns(documents);
  const query = sql`SELECT d.* FROM (${documentsQuery(view)}) shown JOIN documents d ON d.id = shown.id
    UNION ALL SELECT d.* FROM documents d WHERE NOT d.hidden AND d.deleted_at IS NOT NULL`;
  return subquery(query, columns, "document_identities");
}

/** Canonical visible folders plus non-hidden deleted ancestor diagnostics. */
export function identityFolders(view: TreeView) {
  const columns = getTableColumns(folders);
  const query = sql`SELECT f.* FROM (${foldersQuery(view)}) shown JOIN folders f ON f.id = shown.id
    UNION ALL SELECT f.* FROM folders f WHERE NOT f.hidden AND f.deleted_at IS NOT NULL`;
  return subquery(query, columns, "folder_identities");
}

/** Plain selections for nested Drizzle selects (a Subquery itself is not a selection). */
export function visibleDocumentFields(
  relation: VisibleDocumentsSubquery,
): typeof visibleDocumentColumns {
  return Object.fromEntries(
    Object.keys(visibleDocumentColumns).map((key) => [
      key,
      relation[key as keyof typeof visibleDocumentColumns],
    ]),
  ) as typeof visibleDocumentColumns;
}

export function identityDocumentFields(relation: ReturnType<typeof identityDocuments>) {
  const columns = getTableColumns(documents);
  return Object.fromEntries(
    Object.keys(columns).map((key) => [key, relation[key as keyof typeof columns]]),
  ) as typeof columns;
}

export function identityFolderFields(relation: ReturnType<typeof identityFolders>) {
  const columns = getTableColumns(folders);
  return Object.fromEntries(
    Object.keys(columns).map((key) => [key, relation[key as keyof typeof columns]]),
  ) as typeof columns;
}

/** A hidden, live document matched at one location, with how many active drafts use it. */
export type HiddenDocumentCandidate = {
  id: DocumentId;
  /** The row's physical source, which a reveal locks with its destination. */
  sourceId: ContextSourceId;
  /** Active drafts with a `created` row on it; zero is an inconsistent row (repair on touch). */
  activeUses: number;
};

/** Where a create puts a document: (source, folder, name, extension). */
export type DocumentSlot = {
  contextSourceId: ContextSourceId;
  folderId: FolderId | null;
  name: string;
  extension: string;
};

const textDocument = sql`d.storage_url IS NULL AND d.file_type NOT IN (${sql.join(
  [...BINARY_FILE_TYPES].map((fileType) => sql`${fileType}`),
  sql`, `,
)})`;

/**
 * Hidden, live text documents at `slot`, oldest first, matched by the row's own location,
 * excluding the documents
 * `excludeDraftId` already uses (§6.2 step 3). Binaries are never candidates (12b-Q2).
 * `ids` narrows the match to rows already locked, for revalidation under their locks.
 */
export async function loadHiddenDocumentCandidates(
  db: DrizzleDb,
  slot: DocumentSlot,
  options: { excludeDraftId?: DraftId; ids?: readonly DocumentId[] } = {},
): Promise<HiddenDocumentCandidate[]> {
  if (options.ids && options.ids.length === 0) return [];
  const sameFolder = (column: string) =>
    slot.folderId === null
      ? sql`${sql.raw(column)} IS NULL`
      : sql`${sql.raw(column)} = ${slot.folderId}::uuid`;
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    source_id: string;
    active_uses: number;
  }>(sql`
    SELECT d.id::text AS id, d.context_source_id::text AS source_id,
      (SELECT count(*)::int FROM draft_tree_changes u JOIN drafts r ON r.id = u.draft_id
        WHERE u.node_kind = 'document' AND u.node_id = d.id AND u.created
          AND r.status = 'active') AS active_uses
    FROM documents d
    WHERE d.hidden AND d.deleted_at IS NULL AND ${textDocument}
      AND d.context_source_id = ${slot.contextSourceId}::uuid AND ${sameFolder("d.folder_id")}
      AND d.name = ${slot.name} AND d.extension = ${slot.extension}
      ${
        options.excludeDraftId
          ? sql`AND NOT EXISTS (SELECT 1 FROM draft_tree_changes x
              WHERE x.draft_id = ${options.excludeDraftId}::uuid AND x.node_kind = 'document'
                AND x.node_id = d.id)`
          : sql``
      }
      ${options.ids ? sql`AND d.id IN (${uuidList(options.ids)})` : sql``}
    ORDER BY d.created_at, d.id`);
  return rows.map((row) => ({
    id: row.id as DocumentId,
    sourceId: row.source_id as ContextSourceId,
    activeUses: Number(row.active_uses),
  }));
}

/** Filenames the live hidden documents and folders of one folder hold: names no live create takes. */
export async function loadHiddenFilenames(
  db: DrizzleDb,
  contextSourceId: ContextSourceId,
  folderId: FolderId | null,
): Promise<string[]> {
  const inFolder = (column: string) =>
    folderId === null ? sql.raw(`${column} IS NULL`) : sql`${sql.raw(column)} = ${folderId}::uuid`;
  const tx = currentDrizzleDb(db);
  const docs = await tx.execute<{ name: string; extension: string }>(sql`
    SELECT d.name, d.extension FROM documents d
    WHERE d.hidden AND d.deleted_at IS NULL AND d.context_source_id = ${contextSourceId}::uuid
      AND ${inFolder("d.folder_id")}`);
  const subfolders = await tx.execute<{ name: string }>(sql`
    SELECT f.name FROM folders f
    WHERE f.hidden AND f.deleted_at IS NULL AND f.context_source_id = ${contextSourceId}::uuid
      AND ${inFolder("f.parent_id")}`);
  return [
    ...docs.map((row) => renderFilename(row.name, row.extension)),
    ...subfolders.map((row) => folderDocumentName(row.name)),
  ];
}

/** The oldest hidden, live folder at (source, parent, name), else null. */
export async function findHiddenFolder(
  db: DrizzleDb,
  at: { contextSourceId: ContextSourceId; parentId: FolderId | null; name: string },
): Promise<FolderId | null> {
  const [row] = await currentDrizzleDb(db).execute<{ id: string }>(sql`
    SELECT f.id::text AS id FROM folders f
    WHERE f.hidden AND f.deleted_at IS NULL AND f.context_source_id = ${at.contextSourceId}::uuid
      AND ${at.parentId === null ? sql`f.parent_id IS NULL` : sql`f.parent_id = ${at.parentId}::uuid`}
      AND f.name = ${at.name}
    ORDER BY f.created_at, f.id
    LIMIT 1`);
  return (row?.id ?? null) as FolderId | null;
}

/** A folder row by id, whatever its visibility: what placement and end of use decide from. */
export type FolderIdentityRow = {
  id: FolderId;
  hidden: boolean;
  deleted: boolean;
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
};

export async function loadFolderIdentityRows(
  db: DrizzleDb,
  ids: readonly FolderId[],
): Promise<FolderIdentityRow[]> {
  if (ids.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    hidden: boolean;
    deleted: boolean;
    context_source_id: string;
    parent_id: string | null;
    name: string;
  }>(sql`
    SELECT f.id::text AS id, f.hidden, f.deleted_at IS NOT NULL AS deleted,
      f.context_source_id::text AS context_source_id, f.parent_id::text AS parent_id, f.name
    FROM folders f WHERE f.id IN (${uuidList(ids)})`);
  return rows.map((row) => ({
    id: row.id as FolderId,
    hidden: row.hidden,
    deleted: row.deleted,
    contextSourceId: row.context_source_id as ContextSourceId,
    parentId: row.parent_id as FolderId | null,
    name: row.name,
  }));
}

/**
 * Whether a hidden, live folder is unused: nothing live under it, hidden or not (no
 * non-deleted document or folder), which includes every draft's created documents (§12.2 step 5).
 */
export async function isUnusedHiddenFolder(db: DrizzleDb, folderId: FolderId): Promise<boolean> {
  const [row] = await currentDrizzleDb(db).execute<{ unused: boolean }>(sql`
    SELECT (f.hidden AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL)
    ) AS unused
    FROM folders f WHERE f.id = ${folderId}::uuid`);
  return row?.unused === true;
}

/** One live row of a folder subtree, whatever its visibility: what a split or move plans from. */
export type SubtreeNode = {
  kind: "document" | "folder";
  id: string;
  parentId: FolderId | null;
  contextSourceId: ContextSourceId;
  name: string;
  /** Documents only. */
  extension: string | null;
  hidden: boolean;
};

/** A hidden node whose parent is a visible folder that leaves its path (§8.3 step 1). */
export type SplitBoundary = NodeRef & { parentId: FolderId };

/**
 * Every live folder under these roots (roots included) and every live document in
 * them, hidden ones included, in one snapshot taken before anything moves.
 */
export async function loadSubtreeNodes(
  db: DrizzleDb,
  roots: readonly FolderId[],
): Promise<SubtreeNode[]> {
  if (roots.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{
    kind: "document" | "folder";
    id: string;
    parent_id: string | null;
    context_source_id: string;
    name: string;
    extension: string | null;
    hidden: boolean;
  }>(sql`
    WITH RECURSIVE tree AS (
      SELECT f.id FROM folders f WHERE f.id IN (${uuidList(roots)}) AND f.deleted_at IS NULL
      UNION
      SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
    )
    SELECT 'folder' AS kind, f.id::text AS id, f.parent_id::text AS parent_id,
      f.context_source_id::text AS context_source_id, f.name, NULL::text AS extension, f.hidden
    FROM folders f JOIN tree t ON t.id = f.id
    UNION ALL
    SELECT 'document', d.id::text, d.folder_id::text, d.context_source_id::text, d.name,
      d.extension, d.hidden
    FROM documents d JOIN tree t ON t.id = d.folder_id
    WHERE d.deleted_at IS NULL`);
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    parentId: row.parent_id as FolderId | null,
    contextSourceId: row.context_source_id as ContextSourceId,
    name: row.name,
    extension: row.extension,
    hidden: row.hidden,
  }));
}
