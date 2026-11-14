/** Project areas, read from the replay, and opening trails for path and placement menus. */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, type LucideIcon } from "lucide-react";
import type { ServerOpenDocument } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import type { TreeEntry, TreeView } from "@/core/project-tree/tree-view";
import { fileKindIcon } from "./context-file-icon";
import { serverDocumentFromFile } from "./open-document-from-file";

export type MenuArea = {
  /** A stable folder id for the area itself, never a node id. */
  id: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  /** The row at the root. */
  name: string;
  /** What the back row says inside the area, when that differs from the row. */
  title?: string;
  icon: LucideIcon;
  tree: TreeView | null;
  /** Unlisted areas are reachable (the open document lives there) but not offered at the root. */
  listed: boolean;
  /** A chat rebound onto a Work keeps its lineage's notes under one folder. */
  earlier?: { tree: TreeView | null; rootThreadId: string };
};

function listChildren(tree: TreeView, parentId: string | null): DrillNode[] {
  return tree.children(parentId ?? tree.root.entryId).map((node) => ({
    id: node.entryId,
    documentId: node.kind === "dir" ? undefined : node.documentId,
    name: node.name,
    folder: node.kind === "dir",
    icon: node.kind === "dir" ? Folder : fileKindIcon(node),
    editable: node.kind === "dir" ? undefined : node.editable,
  }));
}

const earlierId = (area: MenuArea) => `earlier:${area.id}`;

function earlierHasNotes(area: MenuArea): boolean {
  return (area.earlier?.tree?.files().length ?? 0) > 0;
}

export function areaNode(area: MenuArea): DrillNode {
  return { id: area.id, name: area.name, title: area.title, folder: true, icon: area.icon };
}

function areaTop(area: MenuArea): DrillNode[] {
  const own = area.tree ? listChildren(area.tree, null) : [];
  return earlierHasNotes(area)
    ? [{ id: earlierId(area), name: t`Earlier notes`, folder: true, icon: Folder }, ...own]
    : own;
}

export function buildMenuTree({
  heading,
  areas,
}: {
  heading: string;
  areas: readonly MenuArea[];
}): DrillTree {
  return {
    heading,
    children: (folderId) => {
      if (folderId === null) return areas.filter((area) => area.listed).map(areaNode);
      const area = areas.find((candidate) => candidate.id === folderId);
      if (area) return areaTop(area);
      for (const candidate of areas) {
        if (folderId === earlierId(candidate))
          return candidate.earlier?.tree ? listChildren(candidate.earlier.tree, null) : [];
        if (candidate.tree && menuEntryFor(candidate.tree, folderId))
          return listChildren(candidate.tree, folderId);
        if (candidate.earlier?.tree && menuEntryFor(candidate.earlier.tree, folderId))
          return listChildren(candidate.earlier.tree, folderId);
      }
      return [];
    },
  };
}

/** The tab a picked row opens as, from whichever area holds it. */
export function menuTabFor(areas: readonly MenuArea[], rowId: string): ServerOpenDocument | null {
  for (const area of areas) {
    const own = area.tree?.files().find((file) => file.entryId === rowId);
    if (own) return serverDocumentFromFile(area.scheme, own, area.owner);
    const old = area.earlier?.tree?.files().find((file) => file.entryId === rowId);
    if (old && area.earlier)
      return serverDocumentFromFile("scratch", old, { rootThreadId: area.earlier.rootThreadId });
  }
  return null;
}

/**
 * The trail that walks an area's own tree down through `folders` (names from
 * the area root): the area, then each folder, outermost first. Every menu that
 * opens along a path builds its trail here; callers choose how far down.
 */
export function trailAlong(area: MenuArea, folders: readonly string[]): DrillNode[] {
  const { tree } = area;
  const nodes = tree
    ? folders.flatMap((_, index) => {
        const folder = tree.findPath(`/${folders.slice(0, index + 1).join("/")}`);
        return folder?.kind === "dir"
          ? [{ id: folder.entryId, name: folder.name, folder: true, icon: Folder }]
          : [];
      })
    : [];
  return [areaNode(area), ...nodes];
}

/** The segments of a tree path, from the area root. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** A folder or file of this tree by its id; an id of another source's tree is no row here. */
export function menuEntryFor(tree: TreeView, rowId: string): TreeEntry | null {
  return tree.entry(rowId);
}

/** A crumb opens the list it sits in; an area absent from the root opens inside itself. */
export function crumbTrailFor(
  area: MenuArea | null | undefined,
  path: string,
  depth: number,
): DrillNode[] {
  if (!area) return [];
  const trail = trailAlong(area, pathSegments(path).slice(0, -1));
  return trail.slice(0, depth === 0 && !area.listed ? 1 : depth);
}
