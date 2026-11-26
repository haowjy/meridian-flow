import { t } from "@lingui/core/macro";
import type { TrashEntry } from "@/client/query/useDocumentTrash";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { entrySystem } from "./entry";
import type { PlacementView } from "./move-plan";

export type RestorePlan =
  | { kind: "none" }
  | { kind: "refuse"; label: string }
  | {
      kind: "ready";
      entries: readonly TrashEntry[];
      destination: TreeDestination;
      destinationName: string;
      beside?: { kind: "before" | "after"; name: string };
    };

export type ReadyRestore = Extract<RestorePlan, { kind: "ready" }>;

export function restoreLabel({ destinationName, beside }: ReadyRestore): string {
  const sibling = beside?.name ?? "";
  if (!beside) return t`Restore to ${destinationName}`;
  return beside.kind === "before" ? t`Restore before ${sibling}` : t`Restore after ${sibling}`;
}

export function planRestore(
  view: PlacementView,
  entries: readonly TrashEntry[],
  target: TreeDropTarget,
): RestorePlan {
  const area = view.areas.find((candidate) => candidate.tree.root.entryId === target.treeRootId);
  if (!area?.writable || target.scheme !== area.scheme || entries.length === 0)
    return { kind: "none" };
  const folder = target.folder ? area.tree.entry(target.folder.entryId) : null;
  if (target.folder && folder?.kind !== "dir") return { kind: "none" };
  const into = folder?.entryId ?? area.tree.root.entryId;
  const destinationName = folder?.name ?? schemeLabel(area.scheme);
  const system = entrySystem(area.scheme, area.owner);
  if (
    (system !== "project" && system !== "user") ||
    entries.some((entry) => entrySystem(entry.scheme, {}) !== system)
  )
    return { kind: "refuse", label: t`Can't restore into ${destinationName}` };
  const position = target.position;
  if (!position)
    return { kind: "ready", entries, destination: { parentId: into }, destinationName };
  if (!("siblingId" in position)) return { kind: "none" };
  const anchor = area.tree.children(into).find((child) => child.entryId === position.siblingId);
  if (!anchor) return { kind: "none" };
  return {
    kind: "ready",
    entries,
    destination: { parentId: into, position },
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
  };
}
