/**
 * The tree's rows: real catalog nodes and one temporary folder root per import. A pending row is not a catalog document: it has no URI, editor
 * classification or document capabilities, so navigation and namespace actions
 * need the catalog variant. Document lookup stays on the canonical catalog.
 */
import { compareDefaultSiblings } from "@meridian/resource-replica";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogNode,
} from "@/client/query/context-catalog-projection";

/** A real catalog node with its ordinary capabilities. */
export type CatalogRow = { origin: "catalog"; node: CatalogNode };

/** A temporary root while the server builds out of sight. */
export type PendingRow = {
  origin: "import";
  id: string;
  parentId: string;
  kind: "dir";
  name: string;
  importId: string;
};

export type TreeRow = CatalogRow | PendingRow;

/** Catalog rows and pending roots grouped by parent. */
export type ImportedTree = {
  root: CatalogDirectory;
  rows(parentId: string): readonly TreeRow[];
};

export const rowId = (row: TreeRow): string =>
  row.origin === "import" ? row.id : row.node.entryId;

export const rowKind = (row: TreeRow): "dir" | "file" =>
  row.origin === "import" ? row.kind : row.node.kind;

export const rowName = (row: TreeRow): string =>
  row.origin === "import" ? row.name : row.node.name;

/** Pending roots reserve no names; only catalog siblings constrain namespace edits. */
export const siblingsOf = (rows: readonly TreeRow[]) =>
  rows
    .filter((row) => row.origin === "catalog")
    .map((row) => ({ entryId: rowId(row), name: rowName(row), kind: rowKind(row) }));

/** The tree of a catalog no import touches. */
export function plainTree(catalog: CatalogContextView): ImportedTree {
  const cache = new Map<string, readonly TreeRow[]>();
  return {
    root: catalog.root,
    rows(parentId) {
      let rows = cache.get(parentId);
      if (!rows) {
        rows = catalog.children(parentId).map((node) => ({ origin: "catalog", node }));
        cache.set(parentId, rows);
      }
      return rows;
    },
  };
}

/**
 * A pending root sits where its folder will land: the end of a manual parent, its slot in
 * default order otherwise, so the row does not jump when the import is revealed.
 */
export function withPendingRoots(
  rows: readonly TreeRow[],
  pending: readonly PendingRow[],
  manual: boolean,
): readonly TreeRow[] {
  if (manual) return [...rows, ...pending];
  const placed = [...rows];
  const order = (row: TreeRow) => ({
    kind: rowKind(row) === "dir" ? ("folder" as const) : ("file" as const),
    name: rowName(row),
    identity: rowId(row),
  });
  for (const root of pending) {
    const at = placed.findIndex((row) => compareDefaultSiblings(order(row), order(root)) > 0);
    placed.splice(at < 0 ? placed.length : at, 0, root);
  }
  return placed;
}
