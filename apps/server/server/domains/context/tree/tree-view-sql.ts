/**
 * The tree view's SQL: the only file that reads the hidden predicate (rule 1).
 *
 * Builds the live and branch relations every reader selects from, and the identity rows
 * the tree view decides from. Readers compose these through `tree-view.ts`; nothing else
 * reads `documents.hidden` or `folders.hidden`.
 *
 * Live is the predicate over the table, so Postgres flattens it into the reader's query.
 * A branch view is a `UNION ALL` of disjoint arms: live rows the branch neither moved nor
 * deleted; the branch's hidden creations at their row; the documents it moved, at its
 * placement (its effective placement: a folder's source, so a live move of that folder
 * carries them); and the deleted documents it still has pending changes to (D79: a draft
 * outlives a live delete of its document). A document the branch deleted is in none. Folders
 * have no change rows yet, so a branch's folders are the live ones plus the hidden and
 * deleted ones its documents sit under.
 */
import type { BranchId, ContextSourceId, DocumentId, FolderId, WorkId } from "@meridian/contracts";
import { folderDocumentName, renderFilename } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import { branchTreeChanges, documents, folders } from "@meridian/database/schema";
import { and, eq, getTableColumns, inArray, isNull, type SQL, Subquery, sql } from "drizzle-orm";
import { bigint, boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
  rank: text("rank"),
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
  rank: text("rank"),
  orderPolicy: text("order_policy").$type<"default" | "manual">().notNull(),
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
  "f.id, f.context_source_id, f.parent_id, f.name, f.description, f.rank, f.order_policy, f.hidden, " +
    "f.location_version, f.created_at, f.updated_at",
);

/** The predicate: a document row in the live tree. */
const liveDocument = sql.raw("d.deleted_at IS NULL AND NOT d.hidden");
/** A hidden document the branch created, on alias `c`, where it stands: not moved or deleted. */
const branchCreatedDocument = sql.raw(
  "d.deleted_at IS NULL AND d.hidden AND c.created AND NOT c.moved AND NOT c.deleted",
);
/**
 * A visible document's own delete or its folder's, on alias `d`: never a discard, a Work
 * cascade (its Restore owns it), or a hidden row. The one definition of a deletion a draft
 * outlives: with `pendingIn` the branch lists it; with an active Work draft the branch
 * admits writes to it (`survivingDraftDocuments`).
 */
const DELETED_DOCUMENT =
  "d.deleted_at IS NOT NULL AND NOT d.hidden AND d.deletion_reason = 'deleted' " +
  "AND d.deleted_by_work_id IS NULL";
export const deletedDocument = sql.raw(DELETED_DOCUMENT);
/**
 * The branch's move of document `d`, on alias `c` (its logical state is moving: `deleted`
 * masks a move): a living document live has, the branch's own hidden creation, or one deleted
 * live that a draft outlives (Apply restores it at the branch's placement).
 */
const movedDocument = sql.raw(
  `c.moved AND NOT c.deleted AND ((d.deleted_at IS NULL AND (NOT d.hidden OR c.created)) OR (${DELETED_DOCUMENT}))`,
);
/** A visible folder's delete: in a branch's view only above a document it still has. */
const deletedFolder = sql.raw("f.deleted_at IS NOT NULL AND NOT f.hidden");
/**
 * A folder a branch's view may show besides live ones: a branch's hidden folder, or a visible
 * folder's delete above a document a draft outlived. Each only where the branch uses it
 * (`usedFolderIds`). Spelled as `folders_nonlive_location`'s predicate, so a slot lookup
 * reaches that index.
 */
const nonLiveFolder = sql.raw(
  "((f.hidden AND f.deleted_at IS NULL) OR (NOT f.hidden AND f.deleted_at IS NOT NULL))",
);

/** Branch `b`'s row on document `d` has a move or delete: `d` leaves its live and surviving arms. */
function treeFactOf(b: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM branch_tree_changes x
    WHERE x.branch_id = ${b} AND x.node_kind = 'document' AND x.node_id = d.id
      AND (x.moved OR x.deleted))`;
}

/** The moved placement differs from the row's own, on aliases `c` and `d`. */
const movedElsewhere = sql.raw(
  "NOT (c.moved_folder_id IS NOT DISTINCT FROM d.folder_id " +
    "AND (c.moved_folder_id IS NOT NULL OR c.moved_root_source_id = d.context_source_id) " +
    "AND c.moved_name = d.name AND c.moved_extension = d.extension " +
    "AND c.moved_rank IS NOT DISTINCT FROM d.rank)",
);

/**
 * The one reviewable-pending predicate (design-v2 §1): branch `b` has a change to document
 * `d` that review lists, the Work's count counts and Apply all applies. From the row's
 * logical state (deleting, moving, created; delete dominant) against live's, or an active
 * Work draft with an effect, unless the branch is deleting the document: a drafted delete
 * hides its text changes everywhere. The view's surviving arm, review membership, the
 * pending counts and per-document branch hints all read this; write admission does not
 * (`survivingDraftDocuments`).
 */
export function pendingIn(b: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM branch_tree_changes c
      WHERE c.branch_id = ${b} AND c.node_kind = 'document' AND c.node_id = d.id AND (
        (c.deleted AND d.deleted_at IS NULL AND NOT d.hidden)
        OR (c.moved AND NOT c.deleted AND (
          (d.deleted_at IS NULL AND NOT d.hidden AND ${movedElsewhere})
          OR (d.deleted_at IS NULL AND d.hidden AND c.created)
          OR (${deletedDocument})))
        OR (c.created AND NOT c.moved AND NOT c.deleted AND d.deleted_at IS NULL)))
    OR (EXISTS (SELECT 1 FROM document_drafts dd
        WHERE dd.document_id = d.id AND dd.branch_id = ${b}
          AND dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect)
      AND NOT EXISTS (SELECT 1 FROM branch_tree_changes x
        WHERE x.branch_id = ${b} AND x.node_kind = 'document' AND x.node_id = d.id
          AND x.deleted)))`;
}

/**
 * Every (branch, document) the reviewable-pending predicate holds for, among the branches
 * `branches` selects (a SQL list of branch ids): the Work counts and the branch hints.
 */
export function pendingDocuments(branches: SQL, documentId?: DocumentId): SQL {
  const one = documentId ? sql` AND candidate.document_id = ${documentId}::uuid` : sql``;
  return sql`SELECT candidate.branch_id, candidate.document_id FROM (
      SELECT c.branch_id, c.node_id AS document_id FROM branch_tree_changes c
      WHERE c.node_kind = 'document' AND c.branch_id IN (${branches})
      UNION
      SELECT dd.branch_id, dd.document_id FROM document_drafts dd
      WHERE dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect
        AND dd.branch_id IN (${branches})
    ) candidate
    JOIN documents d ON d.id = candidate.document_id
    WHERE ${pendingIn(sql`candidate.branch_id`)}${one}`;
}

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
/** A moved document's placement in the branch, on aliases `c` and `mf` (its folder). */
const movedLocation = {
  source: "coalesce(mf.context_source_id, c.moved_root_source_id)",
  parent: "c.moved_folder_id",
  name: "c.moved_name",
};

/**
 * Live rows the branch neither moved nor deleted, the hidden documents D created where they
 * stand, the documents D moved at D's placement, and the deleted documents D has pending
 * changes to and no move or delete of. Each arm is a separate SQL UNION branch so a path
 * predicate reaches an index; they are disjoint, so each document appears once.
 */
function documentsQuery(view: TreeView, match?: SlotMatch): SQL {
  const slots = slotted(match, "key, source_id, parent_id, name, extension");
  const select = match
    ? sql`SELECT p.key, d.id`
    : sql`SELECT d.id, d.context_source_id, d.folder_id, d.name, d.extension, d.rank, ${documentTail}`;
  const live = sql`${select}
    FROM ${slots}documents d WHERE ${liveDocument}${at(match, rowLocation, "d.extension")}`;
  if (view.kind === "live") return live;
  const branch = sql`${view.branchId}::uuid`;
  const moved = match
    ? sql`SELECT p.key, d.id`
    : sql`SELECT d.id, coalesce(mf.context_source_id, c.moved_root_source_id) AS context_source_id,
        c.moved_folder_id AS folder_id, c.moved_name AS name, c.moved_extension AS extension,
        c.moved_rank AS rank,
        ${documentTail}`;
  return sql`${live} AND NOT ${treeFactOf(branch)}
    UNION ALL
    ${select}
    FROM ${slots}branch_tree_changes c JOIN documents d ON d.id = c.node_id
    WHERE c.branch_id = ${branch} AND c.node_kind = 'document' AND ${branchCreatedDocument}${at(match, rowLocation, "d.extension")}
    UNION ALL
    ${moved}
    FROM ${slots}branch_tree_changes c JOIN documents d ON d.id = c.node_id
      LEFT JOIN folders mf ON mf.id = c.moved_folder_id
    WHERE c.branch_id = ${branch} AND c.node_kind = 'document' AND ${movedDocument}${at(match, movedLocation, "c.moved_extension")}
    UNION ALL
    ${select}
    FROM ${slots}documents d
    WHERE ${deletedDocument} AND NOT ${treeFactOf(branch)} AND ${pendingIn(branch)}${at(match, rowLocation, "d.extension")}`;
}

/**
 * Folders D's view places something under, and their ancestors (TM invariant 1): seeded
 * from D's change rows (each row's document is one primary-key probe: where a creation
 * stands, or where D moved a document) and from the deleted documents D has pending
 * changes to, in one walk. The non-live arm keeps the hidden and the deleted ones; live
 * ones are already in the live arm.
 */
function usedFolderIds(branchId: BranchId): SQL {
  return sql`
    WITH RECURSIVE used(id) AS (
      SELECT placed.folder_id FROM branch_tree_changes c
      CROSS JOIN LATERAL (
        SELECT CASE WHEN c.moved THEN c.moved_folder_id ELSE d.folder_id END AS folder_id
        FROM documents d
        WHERE d.id = c.node_id AND (${branchCreatedDocument} OR ${movedDocument}) OFFSET 0
      ) placed
      WHERE c.branch_id = ${branchId}::uuid AND c.node_kind = 'document'
        AND placed.folder_id IS NOT NULL
      UNION
      SELECT c.node_id FROM branch_tree_changes c
      WHERE c.branch_id = ${branchId}::uuid AND c.node_kind = 'folder' AND c.created
      UNION
      SELECT d.folder_id FROM document_drafts dd JOIN documents d ON d.id = dd.document_id
      WHERE dd.branch_id = ${branchId}::uuid AND dd.kind = 'work_draft' AND dd.status = 'active'
        AND dd.has_effect AND ${deletedDocument} AND d.folder_id IS NOT NULL
        AND NOT ${treeFactOf(sql`${branchId}::uuid`)}
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
  // The live arm stays separate, so live lookups keep their indexes; the hidden and deleted
  // folders share one arm, so the branch's used-ancestor walk runs once.
  return sql`${live}
    UNION ALL
    ${select} FROM ${slots}folders f
    WHERE ${nonLiveFolder}${position}
      AND f.id IN (${usedFolderIds(view.branchId)})`;
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
  rank: string | null;
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
  rank: string | null;
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
    rank: row.rank,
    locationVersion: BigInt(row.location_version),
  };
}

const identityColumns = sql.raw(
  "d.id::text AS id, d.hidden, d.deleted_at IS NOT NULL AS deleted, " +
    "d.context_source_id::text AS context_source_id, d.folder_id::text AS folder_id, d.name, " +
    "d.extension, d.file_type, d.storage_url, d.rank, d.location_version::text AS location_version",
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

/** One active branch that created a document, oldest branch first per document. */
export type BranchUseRow = {
  documentId: DocumentId;
  branchId: BranchId;
  originWorkId: WorkId | null;
  branchCreatedAt: Date;
};

export async function loadActiveBranchUses(
  db: DrizzleDb,
  documentIds: readonly DocumentId[],
): Promise<BranchUseRow[]> {
  if (documentIds.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<{
    document_id: string;
    branch_id: string;
    origin_work_id: string | null;
    branch_created_ms: number;
  }>(sql`
    SELECT c.node_id::text AS document_id, r.id::text AS branch_id,
      r.origin_work_id::text AS origin_work_id,
      (extract(epoch FROM r.created_at) * 1000)::float8 AS branch_created_ms
    FROM branch_tree_changes c JOIN branches r ON r.id = c.branch_id
    JOIN documents d ON d.id = c.node_id
    WHERE c.node_kind = 'document' AND c.node_id IN (${uuidList(documentIds)})
      AND c.created AND r.status = 'active' AND d.deleted_at IS NULL
    ORDER BY c.node_id, r.created_at, r.id`);
  return rows.map((row) => ({
    documentId: row.document_id as DocumentId,
    branchId: row.branch_id as BranchId,
    originWorkId: row.origin_work_id as WorkId | null,
    branchCreatedAt: new Date(Number(row.branch_created_ms)),
  }));
}

/** What one branch says about a document (its `branch_tree_changes` row), as stored. */
export type BranchTreeFactsRow = {
  created: boolean;
  moved: {
    folderId: FolderId | null;
    rootSourceId: ContextSourceId | null;
    name: string;
    extension: string;
    rank: string | null;
  } | null;
  deleted: boolean;
  /** Null only on a created row written before PR 3. */
  revision: bigint | null;
  baseVersion: bigint | null;
};

/**
 * A branch's row on a document with the document's physical identity, and where the branch
 * has it: its moved placement (the folder's source now) when it is moving it, else the row's.
 */
export type BranchTreeRow = DocumentIdentityRow & {
  facts: BranchTreeFactsRow;
  effective: {
    contextSourceId: ContextSourceId;
    folderId: FolderId | null;
    name: string;
    extension: string;
    rank: string | null;
  };
};

/** Every row the branch has on a document (only these documents' when given), oldest first. */
export async function loadBranchTreeRows(
  db: DrizzleDb,
  branchId: BranchId,
  only?: readonly string[],
): Promise<BranchTreeRow[]> {
  if (only?.length === 0) return [];
  const rows = await currentDrizzleDb(db).execute<
    RawIdentityRow & {
      branch_created: boolean;
      branch_moved: boolean;
      branch_deleted: boolean;
      moved_folder_id: string | null;
      moved_root_source_id: string | null;
      moved_source_id: string | null;
      moved_name: string | null;
      moved_extension: string | null;
      moved_rank: string | null;
      revision: string | null;
      base_version: string | null;
    }
  >(sql`
    SELECT ${identityColumns}, c.created AS branch_created, c.moved AS branch_moved,
      c.deleted AS branch_deleted,
      c.moved_folder_id::text AS moved_folder_id,
      c.moved_root_source_id::text AS moved_root_source_id,
      coalesce(mf.context_source_id, c.moved_root_source_id)::text AS moved_source_id,
      c.moved_name, c.moved_extension, c.moved_rank, c.revision::text AS revision,
      c.base_version::text AS base_version
    FROM branch_tree_changes c
    CROSS JOIN LATERAL (
      SELECT * FROM documents d WHERE d.id = c.node_id OFFSET 0
    ) d
    LEFT JOIN folders mf ON mf.id = c.moved_folder_id
    WHERE c.branch_id = ${branchId}::uuid AND c.node_kind = 'document'
      ${only ? sql`AND c.node_id IN (${uuidList(only)})` : sql``}
    ORDER BY c.created_at, c.node_id`);
  return rows.map((row) => {
    const identity = identityRow(row);
    const moved =
      row.branch_moved && row.moved_name !== null && row.moved_extension !== null
        ? {
            folderId: row.moved_folder_id as FolderId | null,
            rootSourceId: row.moved_root_source_id as ContextSourceId | null,
            name: row.moved_name,
            extension: row.moved_extension,
            rank: row.moved_rank,
          }
        : null;
    return {
      ...identity,
      facts: {
        created: row.branch_created,
        moved,
        deleted: row.branch_deleted,
        revision: row.revision === null ? null : BigInt(row.revision),
        baseVersion: row.base_version === null ? null : BigInt(row.base_version),
      },
      effective:
        moved && !row.branch_deleted && row.moved_source_id
          ? {
              contextSourceId: row.moved_source_id as ContextSourceId,
              folderId: moved.folderId,
              name: moved.name,
              extension: moved.extension,
              rank: moved.rank,
            }
          : {
              contextSourceId: identity.contextSourceId,
              folderId: identity.folderId,
              name: identity.name,
              extension: identity.extension,
              rank: identity.rank,
            },
    };
  });
}

/** Of `documentIds`, those the reviewable-pending predicate holds for in this branch. */
export async function loadPendingDocumentIds(
  db: DrizzleDb,
  branchId: BranchId,
  documentIds: readonly DocumentId[],
): Promise<Set<DocumentId>> {
  if (documentIds.length === 0) return new Set();
  const rows = await currentDrizzleDb(db).execute<{ id: string }>(sql`
    SELECT d.id::text AS id FROM documents d
    WHERE d.id IN (${uuidList(documentIds)}) AND ${pendingIn(sql`${branchId}::uuid`)}`);
  return new Set(rows.map((row) => row.id as DocumentId));
}

/** The `hidden` column of a documents alias, for the address loader's identity rows. */
/**
 * A Work's context rows as its restore would bring them back, rendered for the shared
 * document and folder namespace: what is live now and what the Work's delete took
 * (`arriving`). Hidden rows are a branch's and stay hidden through a restore (F11).
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
 * identities, plus discarded creations so their removal can answer. Placement comes from
 * the same SQL UNION branches as visibleDocuments; no other hidden tombstone enters
 * either arm, even with a stale branch change row. A branch's surviving documents are in
 * the canonical arm, so the diagnostic arm leaves them out: each identity appears once.
 */
export function identityDocuments(view: TreeView) {
  const columns = getTableColumns(documents);
  // A branch's moved document stands at the branch's placement: its grants and lineage are
  // the destination's (a manuscript→kb drafted move takes kb's).
  const names = Object.values(columns).map((column) => column.name);
  const canonical = sql.raw(
    names.map((name) => (PLACEMENT_COLUMNS.has(name) ? `shown.${name}` : `d.${name}`)).join(", "),
  );
  const diagnostic = sql.raw(names.map((name) => `d.${name}`).join(", "));
  const query = sql`SELECT ${canonical} FROM (${documentsQuery(view)}) shown JOIN documents d ON d.id = shown.id
    UNION ALL SELECT ${diagnostic} FROM documents d WHERE d.deleted_at IS NOT NULL
      AND (NOT d.hidden OR d.deletion_reason = 'discarded')${
        view.kind === "branch"
          ? sql` AND NOT (${deletedDocument} AND ${branchShowsDeleted(sql`${view.branchId}::uuid`)})`
          : sql``
      }`;
  return subquery(query, columns, "document_identities");
}

/**
 * The living documents a branch view deletes (alias "document_identities", the identity
 * relation's shape): in no branch reader, yet where an undo of that delete brings them back,
 * at their row. Authorization only; listing and availability never read it.
 */
export function branchDeletedDocuments(view: Extract<TreeView, { kind: "branch" }>) {
  const columns = getTableColumns(documents);
  const query = sql`SELECT ${sql.raw(
    Object.values(columns)
      .map((column) => `d.${column.name}`)
      .join(", "),
  )} FROM documents d WHERE d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM branch_tree_changes c
      WHERE c.branch_id = ${view.branchId}::uuid AND c.node_kind = 'document'
        AND c.node_id = d.id AND c.deleted)`;
  return subquery(query, columns, "document_identities");
}

const PLACEMENT_COLUMNS = new Set(["context_source_id", "folder_id", "name", "extension"]);

/** Branch `b`'s view shows deleted document `d`: it moved it, or a draft of it is pending. */
function branchShowsDeleted(b: SQL): SQL {
  return sql`(EXISTS (SELECT 1 FROM branch_tree_changes c
      WHERE c.branch_id = ${b} AND c.node_kind = 'document' AND c.node_id = d.id
        AND c.moved AND NOT c.deleted)
    OR (NOT ${treeFactOf(b)} AND ${pendingIn(b)}))`;
}

/** Canonical visible folders plus non-hidden deleted ancestor diagnostics, each once. */
function identityFoldersQuery(view: TreeView): SQL {
  return sql`SELECT f.* FROM (${foldersQuery(view)}) shown JOIN folders f ON f.id = shown.id
    UNION ALL SELECT f.* FROM folders f WHERE ${deletedFolder}${
      view.kind === "branch" ? sql` AND f.id NOT IN (${usedFolderIds(view.branchId)})` : sql``
    }`;
}

/** The identity-folder relation for raw-SQL readers. */
export function identityFoldersSql(view: TreeView): SQL {
  return sql`(${identityFoldersQuery(view)})`;
}

/** Canonical visible folders plus non-hidden deleted ancestor diagnostics, each once. */
export function identityFolders(view: TreeView) {
  const columns = getTableColumns(folders);
  const query = identityFoldersQuery(view);
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

/** A hidden, live document matched at one location, with how many active branches use it. */
export type HiddenDocumentCandidate = {
  id: DocumentId;
  /** The row's physical source, which a reveal locks with its destination. */
  sourceId: ContextSourceId;
  /** Active branches with a `created` row on it; zero is an inconsistent row (repair on touch). */
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
 * excluding the documents `excludeBranchId` already uses (§6.2 step 3) and those a using
 * branch moved elsewhere (it no longer has them at the slot). Binaries are never candidates (12b-Q2).
 * `ids` narrows the match to rows already locked, for revalidation under their locks.
 */
export async function loadHiddenDocumentCandidates(
  db: DrizzleDb,
  slot: DocumentSlot,
  options: { excludeBranchId?: BranchId; ids?: readonly DocumentId[] } = {},
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
      (SELECT count(*)::int FROM branch_tree_changes u JOIN branches r ON r.id = u.branch_id
        WHERE u.node_kind = 'document' AND u.node_id = d.id AND u.created
          AND r.status = 'active') AS active_uses
    FROM documents d
    WHERE d.hidden AND d.deleted_at IS NULL AND ${textDocument}
      AND d.context_source_id = ${slot.contextSourceId}::uuid AND ${sameFolder("d.folder_id")}
      AND d.name = ${slot.name} AND d.extension = ${slot.extension}
      -- A create joins a candidate only when every branch using it still has it at this slot.
      AND NOT EXISTS (SELECT 1 FROM branch_tree_changes m JOIN branches r ON r.id = m.branch_id
        WHERE m.node_kind = 'document' AND m.node_id = d.id AND m.moved AND r.status = 'active')
      ${
        options.excludeBranchId
          ? sql`AND NOT EXISTS (SELECT 1 FROM branch_tree_changes x
              WHERE x.branch_id = ${options.excludeBranchId}::uuid AND x.node_kind = 'document'
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
 * non-deleted document or folder), which includes every branch's created documents
 * (§12.2 step 5), and no branch holds it for a drafted move (`branch_tree_folders`: every
 * folder a move placed a document in, until that branch's entries on it settle).
 */
export async function isUnusedHiddenFolder(db: DrizzleDb, folderId: FolderId): Promise<boolean> {
  const [row] = await currentDrizzleDb(db).execute<{ unused: boolean }>(sql`
    SELECT (f.hidden AND f.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM branch_tree_folders h WHERE h.folder_id = f.id)
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

/** Complete living identity set for a Work-source cascade under its source namespace locks. */
export async function loadLivingSourceDocumentIds(
  db: DrizzleDb,
  sourceIds: readonly ContextSourceId[],
): Promise<DocumentId[]> {
  if (!sourceIds.length) return [];
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(inArray(documents.contextSourceId, [...sourceIds]), isNull(documents.deletedAt)));
  return rows.map((row) => row.id as DocumentId);
}

/** Creation membership survives cascade removal but is inactive until Restore. */
export function livingDocumentUses(db: DrizzleDb) {
  return db
    .select(getTableColumns(branchTreeChanges))
    .from(branchTreeChanges)
    .innerJoin(documents, eq(documents.id, branchTreeChanges.nodeId))
    .where(and(eq(branchTreeChanges.nodeKind, "document"), isNull(documents.deletedAt)))
    .as("living_document_uses");
}
