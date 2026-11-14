/** Resolve retained placement intent against the picker's currently available folders. */
import type { DrillNode } from "@/components/app/DrillInMenu";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import type { ProjectMenuSource } from "./use-project-menu-source";

export function moveRepairTrail(
  source: Pick<ProjectMenuSource, "tree" | "folderFor">,
  destination: TreeDestination,
  ownTrail: readonly DrillNode[],
): DrillNode[] | null {
  const visit = (trail: DrillNode[]): DrillNode[] | null => {
    const node = trail.at(-1);
    const folder = node && source.folderFor(node.id);
    if (folder && folder.entryId === destination.parentId) return trail;
    for (const child of source.tree.children(node?.id ?? null)) {
      if (!child.folder) continue;
      const found = visit([...trail, child]);
      if (found) return found;
    }
    return null;
  };
  return visit([]) ?? (ownTrail[0] ? visit([ownTrail[0]]) : null);
}
