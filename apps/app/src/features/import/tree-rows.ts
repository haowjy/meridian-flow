import type { TreeDirectory, TreeEntry, TreeView } from "@/core/project-tree/tree-view";

export type TreeNodeRow = { origin: "tree"; node: TreeEntry };

export type PendingRow = {
  origin: "import";
  id: string;
  parentId: string;
  kind: "dir";
  name: string;
  importId: string;
};

export type TreeRow = TreeNodeRow | PendingRow;

export type ImportedTree = {
  root: TreeDirectory;
  rows(parentId: string): readonly TreeRow[];
};

export const rowId = (row: TreeRow): string =>
  row.origin === "import" ? row.id : row.node.entryId;

export const rowKind = (row: TreeRow): "dir" | "file" =>
  row.origin === "import" ? row.kind : row.node.kind;

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

export function withPendingRoots(
  rows: readonly TreeRow[],
  pending: readonly PendingRow[],
): readonly TreeRow[] {
  return [...rows, ...pending];
}
