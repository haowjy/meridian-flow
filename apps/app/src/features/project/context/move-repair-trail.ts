/** Resolve retained placement intent against the picker's currently available folders. */
import type { ResourceDestination } from "@meridian/resource-replica";
import type { DrillNode } from "@/components/app/DrillInMenu";
import type { ProjectMenuSource } from "./use-catalog-menu-source";

export function moveRepairTrail(
  source: Pick<ProjectMenuSource, "tree" | "folderFor">,
  destination: ResourceDestination,
  ownTrail: readonly DrillNode[],
): DrillNode[] | null {
  const targetPath = destination.folderPath.replace(/^\/+|\/+$/g, "");
  const visit = (trail: DrillNode[]): DrillNode[] | null => {
    const node = trail.at(-1);
    const folder = node && source.folderFor(node.id);
    if (
      folder &&
      folder.scheme === destination.scheme &&
      (folder.owner.workId ?? null) === destination.workId &&
      (folder.owner.rootThreadId ?? null) === (destination.rootThreadId ?? null) &&
      folder.path.replace(/^\/+|\/+$/g, "") === targetPath
    )
      return trail;
    for (const child of source.tree.children(node?.id ?? null)) {
      if (!child.folder) continue;
      const found = visit([...trail, child]);
      if (found) return found;
    }
    return null;
  };
  return visit([]) ?? (ownTrail[0] ? visit([ownTrail[0]]) : null);
}
