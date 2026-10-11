/**
 * The tree behind a Scratch listing: what the rail's Scratch section draws and
 * what the dock document's title menu browses.
 *
 * `useCatalogMenuSource` is one area: the chat's Scratch, a named Work's or a
 * No Work chat's lineage, with the lineage's notes under "Earlier notes" after
 * a rebind. `useProjectMenuSource` is the dock document's menu: the project's
 * areas (and the Scratch the writer has on screen) as folders, opening at the
 * document's own folder. Both read the same catalogs the left tree does and
 * build their trees with `menu-tree.ts`.
 */
import { t } from "@lingui/core/macro";
import {
  type ContextOwner,
  contextOwner,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView, useContextCatalogViews } from "@/client/query/useContextCatalog";
import type { ServerContextTab } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { EDITOR_CONTEXT_SCHEMES, schemeIcon, schemeLabel } from "./context-schemes";
import { areaNode, buildMenuTree, foldersIn, type MenuArea, menuTabFor } from "./menu-tree";

const NO_NOTES = () => t`No notes yet. The AI keeps its notes for this chat here.`;

export type CatalogMenuSource = {
  tree: DrillTree;
  /** All listed catalogs have resolved; only then may the rail prune stale folders. */
  ready: boolean;
  /** The tab a picked note opens as. */
  tabFor(rowId: string): ServerContextTab | null;
};

/** The Scratch a chat has on screen: who owns it, what to call it, and any lineage left behind. */
export type ScratchSource = {
  owner: ContextOwner;
  heading: string;
  /** A lineage whose notes stay listed under "Earlier notes" while `owner` is a Work. */
  earlierRootThreadId?: string | null;
};

function useScratchArea(
  projectId: string,
  source: ScratchSource | null,
  { listed, id }: { listed: boolean; id: string },
): (MenuArea & { complete: boolean }) | null {
  const primary = useContextCatalogView(projectId, "scratch", {
    ...(source?.owner ?? {}),
    enabled: source !== null,
  });
  const earlier = useContextCatalogView(projectId, "scratch", {
    ...contextOwner(null, source?.earlierRootThreadId),
    enabled: Boolean(source?.earlierRootThreadId),
  });
  return useMemo(
    () =>
      source
        ? {
            id,
            scheme: "scratch",
            owner: source.owner,
            name: schemeLabel("scratch"),
            title: source.heading,
            icon: schemeIcon("scratch"),
            catalog: primary.catalog,
            complete: primary.isComplete && (!source.earlierRootThreadId || earlier.isComplete),
            listed,
            earlier: source.earlierRootThreadId
              ? { catalog: earlier.catalog, rootThreadId: source.earlierRootThreadId }
              : undefined,
          }
        : null,
    [earlier.catalog, earlier.isComplete, id, listed, primary.catalog, primary.isComplete, source],
  );
}

export function useCatalogMenuSource({
  projectId,
  owner,
  earlierRootThreadId,
  heading,
}: {
  projectId: string;
  /** Whose Scratch the section lists. */
  owner: ContextOwner;
  /** A lineage whose notes stay listed under "Earlier notes" while `owner` is a Work. */
  earlierRootThreadId?: string | null;
  heading: string;
}): CatalogMenuSource {
  const scratch = useMemo(
    () => ({ owner, heading, earlierRootThreadId }),
    [owner, heading, earlierRootThreadId],
  );
  const area = useScratchArea(projectId, scratch, { listed: true, id: "scratch" });
  const areas = useMemo(() => (area ? [area] : []), [area]);
  const tree = useMemo(
    () => buildMenuTree({ heading, empty: NO_NOTES(), areas, rooted: false }),
    [areas, heading],
  );
  return {
    tree,
    ready: area?.complete ?? false,
    tabFor: (rowId) => menuTabFor(areas, rowId),
  };
}

export type ProjectMenuSource = {
  tree: DrillTree;
  tabFor(rowId: string): ServerContextTab | null;
  /** The document's own area, for the current row, rename siblings and the folders to open at. */
  own: { catalog: CatalogContextView | null; openAt(path: string): DrillNode[] };
};

/**
 * The dock document's menu: Manuscript, Knowledge Base, User, Unfiled and the
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
  const scratchArea = useScratchArea(projectId, scratch, { listed: true, id: "area:scratch" });
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

  const tree = useMemo(
    () => buildMenuTree({ heading: title, areas, rooted: true }),
    [areas, title],
  );
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
    own: {
      catalog: ownArea?.catalog ?? null,
      openAt: (path) => (ownArea ? [areaNode(ownArea), ...foldersIn(ownArea, path)] : []),
    },
  };
}
