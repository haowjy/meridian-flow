/** Resolve retained placement intent against the picker's currently available folders. */
import type { ResourceDestination } from "@meridian/resource-replica";
import type { DrillNode } from "@/components/app/DrillInMenu";
import type { ProjectMenuSource } from "./use-project-menu-source";

export function moveRepairTrail(
  source: Pick<ProjectMenuSource, "tree" | "folderFor">,
  destination: ResourceDestination,
  ownTrail: readonly DrillNode[],
): DrillNode[] | null {
  const parent = destination.parent;
  const visit = (trail: DrillNode[]): DrillNode[] | null => {
    const node = trail.at(-1);
    const folder = node && source.folderFor(node.id);
    if (
      folder &&
      (parent.kind === "folder"
        ? folder.entryId === parent.folderId
        : folder.entryId === folder.catalog.root.entryId &&
          folder.scheme === parent.scheme &&
          (folder.owner.workId ?? null) === parent.owner.workId &&
          (folder.owner.rootThreadId ?? null) === (parent.owner.rootThreadId ?? null))
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
