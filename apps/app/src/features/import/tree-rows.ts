/**
 * The tree's rows: real nodes and one temporary folder root per import. A pending row is not a
 * document: it has no URI, editor classification or document capabilities, so navigation and
 * namespace actions need the tree variant. Document lookup stays on the source's tree.
 */
import type { TreeDirectory, TreeEntry, TreeView } from "@/core/project-tree/tree-view";

/** A real node with its ordinary capabilities. */
export type TreeNodeRow = { origin: "tree"; node: TreeEntry };

/** A temporary root while the server builds out of sight. */
export type PendingRow = {
  origin: "import";
  id: string;
  parentId: string;
  kind: "dir";
  name: string;
  importId: string;
};

export type TreeRow = TreeNodeRow | PendingRow;

/** The tree's rows and the pending roots grouped by parent. */
export type ImportedTree = {
  root: TreeDirectory;
  rows(parentId: string): readonly TreeRow[];
};

export const rowId = (row: TreeRow): string =>
  row.origin === "import" ? row.id : row.node.entryId;

export const rowKind = (row: TreeRow): "dir" | "file" =>
  row.origin === "import" ? row.kind : row.node.kind;

export const rowName = (row: TreeRow): string =>
  row.origin === "import" ? row.name : row.node.name;

/** Pending roots reserve no names; only real siblings constrain namespace edits. */
export const siblingsOf = (rows: readonly TreeRow[]) =>
  rows
    .filter((row) => row.origin === "tree")
    .map((row) => ({ entryId: rowId(row), name: rowName(row), kind: rowKind(row) }));

/** The rows of a tree no import touches. */
export function plainTree(tree: TreeView): ImportedTree {
  const cache = new Map<string, readonly TreeRow[]>();
  return {
    root: tree.root,
    rows(parentId) {
      let rows = cache.get(parentId);
      if (!rows) {
        rows = tree.children(parentId).map((node) => ({ origin: "tree", node }));
        cache.set(parentId, rows);
      }
      return rows;
    },
  };
}

/** A pending root sits where its folder will land, at the end, so the row does not jump when the import is revealed. */
export function withPendingRoots(
  rows: readonly TreeRow[],
  pending: readonly PendingRow[],
): readonly TreeRow[] {
  return [...rows, ...pending];
}
