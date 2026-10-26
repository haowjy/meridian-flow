/** Adds only pending folder roots; catalogs remain the sole owner of every real node. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isManualParent } from "@meridian/resource-replica";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useImportsSnapshot, useOptionalImports } from "./ImportProvider";
import { type ImportedTree, type PendingRow, plainTree, withPendingRoots } from "./tree-rows";
export function useImportedTree(
  catalog: CatalogContextView | null,
  scheme: ProjectContextTreeScheme,
  projectId: string,
): ImportedTree | null {
  const coordinator = useOptionalImports()?.coordinator;
  const snapshot = useImportsSnapshot(coordinator ?? null);
  return useMemo(() => {
    if (!catalog) return null;
    const tree = plainTree(catalog);
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
        catalog.normalized.entries.has(summary.root.id),
        local.phase === "reading",
      );
      if (!draw || local.phase === "refused") continue;
      const parentId = summary.destination.folderId ?? catalog.root.entryId;
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
        return roots
          ? withPendingRoots(
              tree.rows(parentId),
              roots,
              isManualParent(catalog.normalized.entries.get(parentId)),
            )
          : tree.rows(parentId);
      },
    };
  }, [catalog, scheme, projectId, snapshot, coordinator]);
}
