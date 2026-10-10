/**
 * The pure part of a document menu's tree: project areas as folders that hold
 * their catalogs' files, an "Earlier notes" folder in a rebound chat's Scratch,
 * and the lookups that turn a picked row back into a tab. `DrillInMenu` and the
 * rail's Scratch section both draw trees built here, so a note lists the same
 * way wherever it is browsed.
 *
 * `rooted` puts the areas themselves at the top (the dock document's menu
 * climbs to them); unrooted, the single area's own entries are the top level
 * (the rail's Scratch section).
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, type LucideIcon } from "lucide-react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { ServerContextTab } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { fileKindIcon } from "./context-file-icon";
import { serverTabFromFile } from "./context-tab-from-file";

export type MenuArea = {
  /** A stable folder id for the area itself, never a catalog entry id. */
  id: string;
  scheme: ProjectContextTreeScheme;
  owner: ContextOwner;
  /** The row at the root. */
  name: string;
  /** What the back row says inside the area, when that differs from the row. */
  title?: string;
  icon: LucideIcon;
  catalog: CatalogContextView | null;
  /** Unlisted areas are reachable (the open document lives there) but not offered at the root. */
  listed: boolean;
  /** A chat rebound onto a Work keeps its lineage's notes under one folder. */
  earlier?: { catalog: CatalogContextView | null; rootThreadId: string };
};

function sortNodes(nodes: DrillNode[]): DrillNode[] {
  return nodes.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
}

function listChildren(catalog: CatalogContextView, parentId: string | null): DrillNode[] {
  return sortNodes(
    catalog.children(parentId ?? catalog.root.entryId).map((node) => ({
      id: node.entryId,
      documentId: node.kind === "dir" ? undefined : node.documentId,
      name: node.name,
      folder: node.kind === "dir",
      icon: node.kind === "dir" ? Folder : fileKindIcon(node),
    })),
  );
}

const earlierId = (area: MenuArea) => `earlier:${area.id}`;

function earlierHasNotes(area: MenuArea): boolean {
  return (area.earlier?.catalog?.files().length ?? 0) > 0;
}

export function areaNode(area: MenuArea): DrillNode {
  return { id: area.id, name: area.name, title: area.title, folder: true, icon: area.icon };
}

function areaTop(area: MenuArea): DrillNode[] {
  const own = area.catalog ? listChildren(area.catalog, null) : [];
  return earlierHasNotes(area)
    ? [{ id: earlierId(area), name: t`Earlier notes`, folder: true, icon: Folder }, ...own]
    : own;
}

export function buildMenuTree({
  heading,
  empty,
  areas,
  rooted,
}: {
  heading: string;
  empty?: string;
  areas: readonly MenuArea[];
  rooted: boolean;
}): DrillTree {
  return {
    heading,
    empty,
    children: (folderId) => {
      if (folderId === null) {
        if (rooted) return areas.filter((area) => area.listed).map(areaNode);
        return areas[0] ? areaTop(areas[0]) : [];
      }
      const area = areas.find((candidate) => candidate.id === folderId);
      if (area) return areaTop(area);
      for (const candidate of areas) {
        if (folderId === earlierId(candidate))
          return candidate.earlier?.catalog ? listChildren(candidate.earlier.catalog, null) : [];
        if (candidate.catalog?.normalized.entries.has(folderId))
          return listChildren(candidate.catalog, folderId);
        if (candidate.earlier?.catalog?.normalized.entries.has(folderId))
          return listChildren(candidate.earlier.catalog, folderId);
      }
      return [];
    },
  };
}

/** The tab a picked row opens as, from whichever area holds it. */
export function menuTabFor(areas: readonly MenuArea[], rowId: string): ServerContextTab | null {
  for (const area of areas) {
    const own = area.catalog?.files().find((file) => file.entryId === rowId);
    if (own) return serverTabFromFile(area.scheme, own, area.owner);
    const old = area.earlier?.catalog?.files().find((file) => file.entryId === rowId);
    if (old && area.earlier)
      return serverTabFromFile("scratch", old, { rootThreadId: area.earlier.rootThreadId });
  }
  return null;
}

/** The folders, outermost first, that hold the file at `path` in an area's own catalog. */
export function foldersIn(area: MenuArea, path: string): DrillNode[] {
  const { catalog } = area;
  if (!catalog) return [];
  const folders = path.split("/").filter(Boolean).slice(0, -1);
  return folders.flatMap((_, index) => {
    const folder = catalog.findPath(`/${folders.slice(0, index + 1).join("/")}`);
    return folder?.kind === "dir"
      ? [{ id: folder.entryId, name: folder.name, folder: true, icon: Folder }]
      : [];
  });
}
