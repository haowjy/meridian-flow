/**
 * Planning a drop of Trash rows on the tree. A restore is a move out of Trash, so it follows the
 * tree's destination rules (a folder, an area root, a row edge) but never crosses systems: it has
 * no Copy to offer, so a project document can't go to Your files, nor the other way. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { t } from "@lingui/core/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import type { TreeDestination } from "@/core/project-tree/tree-view";
import { schemeLabel } from "../context-schemes";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { entrySystem } from "./entry";
import { indexAt, type PlacementView } from "./move-plan";

export type RestorePlan =
  | { kind: "none" }
  | { kind: "refuse"; label: string }
  | {
      kind: "ready";
      entries: readonly DocumentTrashEntry[];
      destination: TreeDestination;
      destinationName: string;
      /** The sibling an edge drop lands beside, by name, for the hint. */
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
  entries: readonly DocumentTrashEntry[],
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
  const index = indexAt(area, into, position, new Set());
  const anchor = area.tree.children(into).find((child) => child.entryId === position.siblingId);
  if (index === null || !anchor) return { kind: "none" };
  return {
    kind: "ready",
    entries,
    destination: { parentId: into, index },
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
  };
}
