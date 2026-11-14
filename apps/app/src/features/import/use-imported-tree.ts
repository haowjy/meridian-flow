/** Adds only pending folder roots; the source's tree remains the sole owner of every real node. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { TreeView } from "@/core/project-tree/tree-view";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { type ImportedTree, type PendingRow, plainTree, withPendingRoots } from "./tree-rows";
export function useImportedTree(
  source: TreeView | null,
  scheme: ProjectContextTreeScheme,
  projectId: string,
): ImportedTree | null {
  const coordinator = useOptionalImports()?.coordinator;
  const snapshot = useImportsSnapshot(coordinator ?? null);
  return useMemo(() => {
    if (!source) return null;
    const tree = plainTree(source);
    const pending = new Map<string, PendingRow[]>();
    for (const { importId, summary, local } of snapshot.imports) {
      if (
        summary.projectId !== projectId ||
        !summary.root ||
        summary.destination.folderUri.split(":")[0] !== scheme
      )
        continue;
      const draw = coordinator?.observeRoot(
        summary,
        source.entry(summary.root.id) !== null,
        local.phase === "reading",
      );
      if (!draw) continue;
      const parentId = summary.destination.folderId ?? source.root.entryId;
      const rows = pending.get(parentId) ?? [];
      rows.push({
        origin: "import",
        id: summary.root.id,
        importId,
        kind: "dir",
        name: summary.root.name,
        parentId,
      });
      pending.set(parentId, rows);
    }
    return {
      root: tree.root,
      rows: (parentId) => {
        const roots = pending.get(parentId);
        return roots ? withPendingRoots(tree.rows(parentId), roots) : tree.rows(parentId);
      },
    };
  }, [source, scheme, projectId, snapshot, coordinator]);
}
