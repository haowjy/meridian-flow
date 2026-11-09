/**
 * Planning a drop of Trash rows on the tree. A restore is a move out of Trash, so it follows the
 * tree's destination rules (a folder, an area root, a row edge) but never crosses systems: it has
 * no Copy to offer, so a project document can't go to Your files, nor the other way. Pure and
 * synchronous: hovering plans on every `dragover`.
 */
import { t } from "@lingui/core/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import type { RestoreDestination } from "@/client/trash-restore/pending-restores";
import { schemeLabel } from "../context-schemes";
import { menuEntryFor } from "../menu-tree";
import { destinationParent } from "../move-entry";
import type { TreeDropTarget } from "../tree-drop/tree-drop";
import { entrySystem } from "./entry";
import type { MoveView } from "./move-plan";

export type RestorePlan =
  | { kind: "none" }
  | { kind: "refuse"; label: string }
  | {
      kind: "ready";
      entries: readonly DocumentTrashEntry[];
      destination: RestoreDestination;
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
  view: MoveView,
  entries: readonly DocumentTrashEntry[],
  target: TreeDropTarget,
): RestorePlan {
  const area = view.areas.find(
    (candidate) => candidate.catalog.root.entryId === target.catalogRootId,
  );
  if (!area?.accepts || target.scheme !== area.scheme || entries.length === 0)
    return { kind: "none" };
  const folder = target.folder ? menuEntryFor(area.catalog, target.folder.entryId) : null;
  if (target.folder && (folder?.kind !== "dir" || folder.navigationOnly)) return { kind: "none" };
  const into = destinationParent(
    {
      scheme: area.scheme,
      owner: area.owner,
      catalog: area.catalog,
      entryId: target.folder?.entryId ?? area.catalog.root.entryId,
    },
    view.works,
    view.noWork,
  );
  if (!into) return { kind: "none" };
  const destinationName = folder?.name ?? schemeLabel(area.scheme);
  const system = entrySystem(area.scheme, area.owner);
  if (
    (system !== "project" && system !== "user") ||
    entries.some((entry) => entrySystem(entry.scheme, {}) !== system)
  )
    return { kind: "refuse", label: t`Can't restore into ${destinationName}` };
  const parent: RestoreDestination["parent"] | null =
    into.kind === "folder"
      ? { kind: "folder", folderId: into.folderId }
      : into.scheme === "manuscript" || into.scheme === "kb" || into.scheme === "user"
        ? { kind: "root", scheme: into.scheme }
        : null;
  if (!parent) return { kind: "none" };
  const position = target.position;
  if (!position) return { kind: "ready", entries, destination: { parent }, destinationName };
  if (!("siblingId" in position)) return { kind: "none" };
  const anchor = view.placement
    .childrenAt(into, view.records)
    .find((child) => child.entryId === position.siblingId);
  if (!anchor) return { kind: "none" };
  return {
    kind: "ready",
    entries,
    destination: { parent, position },
    destinationName,
    beside: { kind: position.kind, name: anchor.name },
  };
}
