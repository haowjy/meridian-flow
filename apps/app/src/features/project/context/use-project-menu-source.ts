/** Catalog-backed project areas for document paths and placement menus. */
import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView, useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useWorks } from "@/client/query/useWorks";
import type { ServerContextTab } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "./context-schemes";
import {
  buildMenuTree,
  crumbTrailFor,
  type MenuArea,
  menuEntryFor,
  menuTabFor,
  pathSegments,
  trailAlong,
} from "./menu-tree";
import { type ScratchSource, useScratchCatalogs } from "./use-scratch-catalogs";

export type ProjectMenuSource = {
  tree: DrillTree;
  tabFor(rowId: string): ServerContextTab | null;
  /** The trail that opens inside a folder, from whichever area holds it; null when none does. */
  trailInside(folderId: string): DrillNode[] | null;
  /** Resolve an area or folder row into its placement destination. */
  folderFor(rowId: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    path: string;
    catalog: CatalogContextView;
    entryId: string;
  } | null;
  /** The own area's catalog and its opening trails. */
  own: {
    catalog: CatalogContextView | null;
    /** Opens in the list holding the entry at `path`. */
    openAt(path: string): DrillNode[];
    /** Opens inside the folder at `folders` (names from the area root). */
    openInside(folders: readonly string[]): DrillNode[];
    crumbTrail(path: string, depth: number): DrillNode[];
  };
};

/**
 * The project browsing tree: Manuscript, Knowledge Base, User, Unfiled and the
 * Scratch on screen as folders under the project's title. The own area (the open
 * document's, an entry being moved, or the folder a mention opens) is always
 * reachable; when it is not one of those (an Uploads file, or another Work's
 * Scratch), its catalog is acquired here and held but not offered at the root.
 */
export function useProjectMenuSource({
  projectId,
  title,
  scratch,
  own,
}: {
  projectId: string;
  /** The root heading: the project's title. */
  title: string;
  /** The Scratch to offer at the root, or null when no chat or Work is in view. */
  scratch: ScratchSource | null;
  /**
   * The own area's scheme and owner, and what to call it when the root does not
   * offer it; null when there is none (the menu opens at the root).
   */
  own: {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    heading: string;
  } | null;
}): ProjectMenuSource {
  const projectViews = useContextCatalogViews(projectId, EDITOR_CONTEXT_SCHEMES, {
    workId: null,
  });
  const { primary, earlier } = useScratchCatalogs(projectId, scratch);
  const scratchArea = useMemo<MenuArea | null>(
    () =>
      scratch
        ? {
            id: "area:scratch",
            scheme: "scratch",
            owner: scratch.owner,
            name: schemeLabel("scratch"),
            title: scratch.heading,
            icon: schemeIcon("scratch"),
            catalog: primary.catalog,
            listed: true,
            earlier: scratch.earlierRootThreadId
              ? { catalog: earlier.catalog, rootThreadId: scratch.earlierRootThreadId }
              : undefined,
          }
        : null,
    [scratch, primary.catalog, earlier.catalog],
  );
  const documentScheme = own?.scheme ?? null;
  const documentOwner = own?.owner ?? null;
  const documentHeading = own?.heading ?? "";
  const sameAsScratch =
    documentScheme === "scratch" &&
    scratch !== null &&
    documentOwner !== null &&
    (scratch.owner.rootThreadId !== undefined
      ? scratch.owner.rootThreadId === documentOwner.rootThreadId
      : documentOwner.rootThreadId === undefined &&
        (scratch.owner.workId ?? null) === (documentOwner.workId ?? null));
  const sameAsProject =
    documentScheme !== null &&
    (EDITOR_CONTEXT_SCHEMES as readonly string[]).includes(documentScheme);
  const hiddenNeeded = documentScheme !== null && !sameAsScratch && !sameAsProject;
  const hidden = useContextCatalogView(projectId, documentScheme ?? "scratch", {
    ...(documentOwner ?? {}),
    enabled: hiddenNeeded,
  });

  const areas = useMemo(() => {
    const list: MenuArea[] = EDITOR_CONTEXT_SCHEMES.map((scheme) => ({
      id: `area:${scheme}`,
      scheme,
      owner: {},
      name: schemeLabel(scheme),
      icon: schemeIcon(scheme),
      catalog: projectViews[scheme]?.catalog ?? null,
      listed: true,
    }));
    if (scratchArea) list.push(scratchArea);
    if (hiddenNeeded && documentScheme && documentOwner)
      list.push({
        id: "area:document",
        scheme: documentScheme,
        owner: documentOwner,
        name: schemeLabel(documentScheme),
        title: documentHeading,
        icon: schemeIcon(documentScheme),
        catalog: hidden.catalog,
        listed: false,
      });
    return list;
  }, [
    projectViews,
    scratchArea,
    hiddenNeeded,
    documentScheme,
    documentOwner,
    documentHeading,
    hidden.catalog,
  ]);

  const tree = useMemo(() => buildMenuTree({ heading: title, areas }), [areas, title]);
  const ownArea = hiddenNeeded
    ? areas.find((area) => area.id === "area:document")
    : sameAsScratch
      ? scratchArea
      : documentScheme
        ? areas.find((area) => area.scheme === documentScheme)
        : undefined;
  return {
    tree,
    tabFor: (rowId) => menuTabFor(areas, rowId),
    trailInside: (folderId) => {
      for (const area of areas) {
        const folder = area.catalog ? menuEntryFor(area.catalog, folderId) : null;
        if (folder?.kind === "dir") return trailAlong(area, pathSegments(folder.path));
      }
      return null;
    },
    folderFor: (rowId) => {
      for (const area of areas) {
        const catalog = area.catalog;
        if (!catalog) continue;
        if (rowId === area.id)
          return {
            scheme: area.scheme,
            owner: area.owner,
            path: "/",
            catalog,
            entryId: catalog.root.entryId,
          };
        const folder = menuEntryFor(catalog, rowId);
        if (folder?.kind === "dir")
          return {
            scheme: area.scheme,
            owner: area.owner,
            path: folder.path,
            catalog,
            entryId: rowId,
          };
      }
      return null;
    },
    own: {
      catalog: ownArea?.catalog ?? null,
      openAt: (path) => (ownArea ? trailAlong(ownArea, pathSegments(path).slice(0, -1)) : []),
      openInside: (folders) => (ownArea ? trailAlong(ownArea, folders) : []),
      crumbTrail: (path, depth) => crumbTrailFor(ownArea, path, depth),
    },
  };
}

/** What a menu calls an area outside the root's: "Scratch for <Work>", or the area's name. */
export function useOwnAreaHeading(
  projectId: string,
  own: { scheme: ProjectContextTreeScheme; owner: ContextOwner } | null,
): string {
  const { works } = useWorks(projectId);
  const workId = own?.owner.workId;
  const rootThreadId = own?.owner.rootThreadId;
  const work = workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  // A document's owner names its own area: the Work, or the chat whose Scratch it is.
  const lineageTitle = useLineageTitle(projectId, rootThreadId ? { rootThreadId } : null);
  const ownerName = work?.name ?? lineageTitle;
  if (!own) return "";
  return ownerName ? t`${schemeLabel(own.scheme)} for ${ownerName}` : schemeLabel(own.scheme);
}
