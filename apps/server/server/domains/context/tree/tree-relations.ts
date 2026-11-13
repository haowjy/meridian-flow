/**
 * The two relations every reader of the tree composes: `visibleDocuments(view)` and
 * `visibleFolders(view)`, over `tree_nodes` (live) and `branch_tree_nodes` (a Work's view). The
 * rows are written only by the replay of the project's list (`adapters/tree-list-rows.ts`);
 * nothing here filters a hidden or tombstoned row, because there is none.
 *
 * A Work's view is the index-friendly union, not a left join: `tree_nodes` rows the Work has no
 * row for, then the Work's own rows. A path walk over it must step one level at a time with a
 * `LATERAL (... OFFSET 0)` subquery or a query per level; a recursive step that joins the
 * relation without it is planned as a hash join of the whole relation (measured in
 * `context/.context/tree-list-store.md`).
 */
import type { BranchId, ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { JsonObject } from "@meridian/contracts/threads";
import { getTableColumns, type SQL, Subquery, sql } from "drizzle-orm";
import { bigint, boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { SelectionProxyHandler } from "drizzle-orm/selection-proxy";

export type TreeView = { kind: "live" } | { kind: "branch"; branchId: BranchId };
export const LIVE_TREE: TreeView = Object.freeze({ kind: "live" });

// The relations' column shapes. Not schema tables: they type and decode the subqueries below,
// and every reference to them renders qualified by the subquery's alias.
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
  hasPreview: boolean("has_preview").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().notNull(),
  rank: text("rank").notNull(),
  locationVersion: bigint("location_version", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const visibleFolderShape = pgTable("visible_folders", {
  id: uuid("id").$type<FolderId>().notNull(),
  contextSourceId: uuid("context_source_id").$type<ContextSourceId>().notNull(),
  parentId: uuid("parent_id").$type<FolderId>(),
  name: text("name").notNull(),
  rank: text("rank").notNull(),
  locationVersion: bigint("location_version", { mode: "bigint" }).notNull(),
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
  "d.storage_url, d.mime_type, d.size_bytes, d.has_preview, d.metadata, d.created_at, d.updated_at",
);

function documentsQuery(view: TreeView): SQL {
  const live = sql`SELECT t.id, t.context_source_id, t.parent_id AS folder_id, t.name, t.extension,
      t.file_type, ${documentTail}, t.rank, t.location_version
    FROM tree_nodes t JOIN documents d ON d.id = t.id
    WHERE t.kind = 'document' AND t.trash_record IS NULL`;
  if (view.kind === "live") return live;
  const branch = sql`${view.branchId}::uuid`;
  return sql`${live} AND NOT EXISTS (
      SELECT 1 FROM branch_tree_nodes x WHERE x.branch_id = ${branch} AND x.id = t.id)
    UNION ALL
    SELECT b.id, b.context_source_id, b.parent_id AS folder_id, b.name, b.extension,
      b.file_type, ${documentTail}, b.rank, coalesce(t.location_version, 0)
    FROM branch_tree_nodes b JOIN documents d ON d.id = b.id
      LEFT JOIN tree_nodes t ON t.id = b.id
    WHERE b.branch_id = ${branch} AND b.kind = 'document' AND NOT b.deleted`;
}

function foldersQuery(view: TreeView): SQL {
  const live = sql`SELECT t.id, t.context_source_id, t.parent_id, t.name, t.rank, t.location_version
    FROM tree_nodes t WHERE t.kind = 'folder' AND t.trash_record IS NULL`;
  if (view.kind === "live") return live;
  const branch = sql`${view.branchId}::uuid`;
  return sql`${live} AND NOT EXISTS (
      SELECT 1 FROM branch_tree_nodes x WHERE x.branch_id = ${branch} AND x.id = t.id)
    UNION ALL
    SELECT b.id, b.context_source_id, b.parent_id, b.name, b.rank, coalesce(t.location_version, 0)
    FROM branch_tree_nodes b LEFT JOIN tree_nodes t ON t.id = b.id
    WHERE b.branch_id = ${branch} AND b.kind = 'folder' AND NOT b.deleted`;
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

/** The columns of a visible-documents relation as selectable fields, for `select(...)`. */
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
