/** A row that can be selected and dragged, with what a move needs to place it and put it back. */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogNode } from "@/client/query/context-catalog-projection";
import type { MoveSubject } from "../move-entry";

export type SelectableEntry = Omit<MoveSubject, "catalog"> & {
  catalog: NonNullable<MoveSubject["catalog"]>;
  /** Unique within the sidebar: scheme and catalog entry. */
  key: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  uri: string;
  /** The parent's path, or "/" at the area's top level (Undo moves it back here). */
  parentPath: string;
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
  catalog: SelectableEntry["catalog"],
): SelectableEntry {
  const parentPath = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "/";
  return {
    key: `${scheme}:${node.entryId}`,
    kind: node.kind === "file" ? "file" : "folder",
    id: node.kind === "file" ? node.documentId : node.entryId,
    name: node.name,
    path: node.path,
    uri: node.uri,
    parentId: node.parentId,
    parentPath,
    catalog,
    scheme,
    owner,
  };
}
