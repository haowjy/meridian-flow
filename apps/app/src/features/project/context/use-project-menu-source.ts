/** Catalog-backed project areas for document paths and placement menus. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView, useContextCatalogViews } from "@/client/query/useContextCatalog";
import type { ServerContextTab } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "./context-schemes";
import {
  areaNode,
  buildMenuTree,
  crumbTrailFor,
  foldersIn,
  type MenuArea,
  menuEntryFor,
  menuTabFor,
} from "./menu-tree";
import { type ScratchSource, useScratchCatalogs } from "./use-scratch-catalogs";

export type ProjectMenuSource = {
  tree: DrillTree;
  tabFor(rowId: string): ServerContextTab | null;
  /** Resolve an area or folder row into its placement destination. */
  folderFor(rowId: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    path: string;
    catalog: CatalogContextView;
    entryId: string;
  } | null;
  /** The document's own catalog and source-owned opening trails. */
  own: {
    catalog: CatalogContextView | null;
    openAt(path: string): DrillNode[];
    crumbTrail(path: string, depth: number): DrillNode[];
  };
};

/**
 * The project browsing tree: Manuscript, Knowledge Base, User, Unfiled and the
 * Scratch on screen as folders under the project's title. The document's own
 * area is always reachable; when it is not one of those (an Uploads file, or a
 * Scratch the writer has since left), it is held but not offered at the root.
 */
export function useProjectMenuSource({
  projectId,
  title,
  scratch,
  document,
}: {
  projectId: string;
  /** The root heading: the project's title. */
  title: string;
  /** The Scratch to offer at the root, or null when no chat or Work is in view. */
  scratch: ScratchSource | null;
  /**
   * The open document's scheme and owner, and what to call its own area when
   * the root does not offer it; null when no document is open (the menu opens
   * at the root).
   */
  document: {
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
  const documentScheme = document?.scheme ?? null;
  const documentOwner = document?.owner ?? null;
  const documentHeading = document?.heading ?? "";
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
      openAt: (path) => (ownArea ? [areaNode(ownArea), ...foldersIn(ownArea, path)] : []),
      crumbTrail: (path, depth) => crumbTrailFor(ownArea, path, depth),
    },
  };
}
