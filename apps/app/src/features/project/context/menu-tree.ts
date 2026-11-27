import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, type LucideIcon } from "lucide-react";
import type { ServerOpenDocument } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import type { TreeEntry, TreeView } from "@/core/project-tree/tree-view";
import { fileKindIcon } from "./context-file-icon";
import { serverDocumentFromFile } from "./open-document-from-file";

export type MenuArea = {
  id: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  name: string;
  title?: string;
  icon: LucideIcon;
  tree: TreeView | null;
  listed: boolean;
  writable: boolean;
  earlier?: { tree: TreeView | null; rootThreadId: string };
};

function listChildren(tree: TreeView, parentId: string | null): DrillNode[] {
  return tree.children(parentId ?? tree.root.entryId).map((node) => ({
    id: node.entryId,
    documentId: node.kind === "dir" ? undefined : node.documentId,
    name: node.name,
    ...(node.suffix ? { suffix: node.suffix } : {}),
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

function earlierNode(area: MenuArea): DrillNode {
  return { id: earlierId(area), name: t`Earlier notes`, folder: true, icon: Folder };
}

function areaTop(area: MenuArea): DrillNode[] {
  const own = area.tree ? listChildren(area.tree, null) : [];
  return earlierHasNotes(area) ? [earlierNode(area), ...own] : own;
}

function folderNodes(tree: TreeView, folders: readonly string[]): DrillNode[] {
  return folders.flatMap((_, index) => {
    const folder = tree.findFolder(folders.slice(0, index + 1).join("/"));
    return folder
      ? [
          {
            id: folder.entryId,
            name: folder.name,
            ...(folder.suffix ? { suffix: folder.suffix } : {}),
            folder: true,
            icon: Folder,
          },
        ]
      : [];
  });
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
    trailInside: (folderId) => {
      for (const area of areas) {
        if (folderId === area.id) return [areaNode(area)];
        if (folderId === earlierId(area) && earlierHasNotes(area))
          return [areaNode(area), earlierNode(area)];
        const own = area.tree ? menuEntryFor(area.tree, folderId) : null;
        if (area.tree && own?.kind === "dir") return trailAlong(area, pathSegments(own.path));
        const old = area.earlier?.tree ? menuEntryFor(area.earlier.tree, folderId) : null;
        if (area.earlier?.tree && old?.kind === "dir")
          return [
            areaNode(area),
            earlierNode(area),
            ...folderNodes(area.earlier.tree, pathSegments(old.path)),
          ];
      }
      return null;
    },
  };
}

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

export function trailAlong(area: MenuArea, folders: readonly string[]): DrillNode[] {
  return [areaNode(area), ...(area.tree ? folderNodes(area.tree, folders) : [])];
}

export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function menuEntryFor(tree: TreeView, rowId: string): TreeEntry | null {
  return tree.entry(rowId);
}

export function crumbTrailFor(
  area: MenuArea | null | undefined,
  path: string,
  depth: number,
): DrillNode[] {
  if (!area) return [];
  const trail = trailAlong(area, pathSegments(path).slice(0, -1));
  return trail.slice(0, depth === 0 && !area.listed ? 1 : depth);
}
