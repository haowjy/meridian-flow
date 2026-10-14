/** A row that can be selected and dragged, with what a move needs to place it and put it back. */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogNode } from "@/client/query/context-catalog-projection";
import type { MoveSubject, PlacementParent } from "../move-entry";

export type SelectableEntry = MoveSubject & {
  catalogRootId: string;
  /** Where it sits now; Undo puts it back here, under whatever name it has by then. */
  origin: PlacementParent;
  /** The row offers Move (its owner is editable, it isn't a navigation-only placeholder). */
  movable: boolean;
  /** Unique within the sidebar: scheme and catalog entry. */
  key: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  uri: string;
};

/**
 * Rows move freely within one system: the project areas are one, and each
 * owner's Scratch or Uploads is its own. Crossing systems is a choice
 * (Move or Copy), not a drop.
 */
export function entrySystem(scheme: ProjectContextTreeScheme, owner: ContextOwner): string {
  if (isProjectScopedScheme(scheme)) return "project";
  return `${scheme}:${owner.rootThreadId ?? owner.workId ?? ""}`;
}

export function selectableEntry(
  node: CatalogNode,
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner,
  root: PlacementParent["root"],
  movable: boolean,
): SelectableEntry {
  return {
    key: `${scheme}:${node.entryId}`,
    kind: node.kind === "file" ? "file" : "folder",
    id: node.kind === "file" ? node.documentId : node.entryId,
    name: node.name,
    path: node.path,
    uri: node.uri,
    parentId: node.parentId,
    catalogRootId: root.entryId,
    origin: { scheme, owner, root, entryId: node.parentId ?? root.entryId },
    movable,
    scheme,
    owner,
  };
}
