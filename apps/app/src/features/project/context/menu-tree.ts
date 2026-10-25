/** Catalog-backed project areas and opening trails for path and placement menus. */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Folder, type LucideIcon } from "lucide-react";
import type { CatalogContextView, CatalogNode } from "@/client/query/context-catalog-projection";
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
          return candidate.earlier?.catalog ? listChildren(candidate.earlier.catalog, null) : [];
        if (candidate.catalog && menuEntryFor(candidate.catalog, folderId))
          return listChildren(candidate.catalog, folderId);
        if (candidate.earlier?.catalog && menuEntryFor(candidate.earlier.catalog, folderId))
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

/**
 * The trail that walks an area's own catalog down through `folders` (names from
 * the area root): the area, then each folder, outermost first. Every menu that
 * opens along a path builds its trail here; callers choose how far down.
 */
export function trailAlong(area: MenuArea, folders: readonly string[]): DrillNode[] {
  const { catalog } = area;
  const nodes = catalog
    ? folders.flatMap((_, index) => {
        const folder = catalog.findPath(`/${folders.slice(0, index + 1).join("/")}`);
        return folder?.kind === "dir"
          ? [{ id: folder.entryId, name: folder.name, folder: true, icon: Folder }]
          : [];
      })
    : [];
  return [areaNode(area), ...nodes];
}

/** The segments of a catalog path, from the area root. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Catalog snapshots span multiple areas; an ID must belong to this projected source. */
export function menuEntryFor(catalog: CatalogContextView, rowId: string): CatalogNode | null {
  const entry = catalog.normalized.entries.get(rowId);
  if (
    !entry ||
    (entry.kind !== "folder" && entry.kind !== "file") ||
    entry.sourceId !== catalog.root.entryId
  )
    return null;
  return catalog.findPath(`/${entry.path.join("/")}`);
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
