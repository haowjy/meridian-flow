/** Project areas read from the replay, for document paths and placement menus. */

import { t } from "@lingui/core/macro";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProjectTreeView, useProjectTreeViews } from "@/client/query/useProjectTree";
import { useWorks } from "@/client/query/useWorks";
import type { ServerOpenDocument } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { useTreeVersion } from "@/core/project-tree/tree-version";
import type { TreeEntry, TreeView } from "@/core/project-tree/tree-view";
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
import { type ScratchSource, useScratchTrees } from "./use-scratch-trees";
import { useWorkSourceWritable } from "./use-work-source-writable";

export type ProjectMenuSource = {
  tree: DrillTree;
  tabFor(rowId: string): ServerOpenDocument | null;
  /** How the tree behind the folder on screen (its trail, outermost first) is loading. */
  loadState(trail: readonly DrillNode[]): "ready" | "loading" | "failed";
  /** The tree and shown node a folder or file id names, from whichever area holds it. */
  locate(id: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    tree: TreeView;
    entry: TreeEntry;
  } | null;
  /** Resolve an area or folder row into its placement destination. */
  folderFor(rowId: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    path: string;
    tree: TreeView;
    /** The folder's id, or the source's id for an area's top: what a destination names as its parent. */
    entryId: string;
    /** Whether the area takes changes (`MenuArea.writable`). */
    writable: boolean;
  } | null;
  /** Whether the area a root row names takes changes. */
  areaWritable(areaId: string): boolean;
  /** The own area's tree and its opening trails. */
  own: {
    tree: TreeView | null;
    /** Whether the own area takes changes. */
    writable: boolean;
    /** Opens in the list holding the entry at `path`. */
    openAt(path: string): DrillNode[];
    /** Opens inside the folder at `folders` (names from the area root). */
    openInside(folders: readonly string[]): DrillNode[];
    crumbTrail(path: string, depth: number): DrillNode[];
  };
};

/**
 * The project browsing tree: Manuscript, Knowledge, User, Unfiled and the
 * Scratch on screen as folders under the project's title. The own area (the open
 * document's, an entry being moved, or the folder a mention opens) is always
 * reachable; when it is not one of those (an Uploads file, or another Work's
 * Scratch), its tree is read here and held but not offered at the root.
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
  // The menu's moves and creates write the shell's version: it reads the same one.
  const version = useTreeVersion();
  const projectViews = useProjectTreeViews(projectId, EDITOR_CONTEXT_SCHEMES, {
    workId: null,
    version,
  });
  const { primary, earlier } = useScratchTrees(projectId, scratch);
  // On a deleted Work's Draft no tree takes a change; a Work's Scratch takes none once it ends.
  const open = version.ended !== "deleted";
  const scratchWritable = useWorkSourceWritable(projectId, scratch?.owner.workId) && open;
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
            tree: primary.tree,
            listed: true,
            writable: scratchWritable,
            earlier: scratch.earlierRootThreadId
              ? { tree: earlier.tree, rootThreadId: scratch.earlierRootThreadId }
              : undefined,
          }
        : null,
    [scratch, primary.tree, earlier.tree, scratchWritable],
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
  const hidden = useProjectTreeView(projectId, documentScheme ?? "scratch", {
    ...documentOwner,
    enabled: hiddenNeeded,
    version,
  });
  const hiddenWritable =
    useWorkSourceWritable(
      projectId,
      documentScheme === "scratch" ? documentOwner?.workId : undefined,
    ) && open;

  const areas = useMemo(() => {
    const list: MenuArea[] = EDITOR_CONTEXT_SCHEMES.map((scheme) => ({
      id: `area:${scheme}`,
      scheme,
      owner: {},
      name: schemeLabel(scheme),
      icon: schemeIcon(scheme),
      tree: projectViews[scheme]?.tree ?? null,
      listed: true,
      writable: open,
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
        tree: hidden.tree,
        listed: false,
        writable: hiddenWritable,
      });
    return list;
  }, [
    projectViews,
    scratchArea,
    hiddenNeeded,
    documentScheme,
    documentOwner,
    documentHeading,
    hidden.tree,
    open,
    hiddenWritable,
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
    loadState: (trail) => {
      const areaId = trail[0]?.id;
      const view =
        areaId === "area:scratch"
          ? trail.at(1)?.id.startsWith("earlier:")
            ? earlier
            : primary
          : areaId === "area:document"
            ? hidden
            : projectViews[areaId?.replace("area:", "") as keyof typeof projectViews];
      return !view || view.tree ? "ready" : view.isError ? "failed" : "loading";
    },
    locate: (id) => {
      for (const area of areas) {
        const entry = area.tree?.entry(id);
        if (area.tree && entry)
          return { scheme: area.scheme, owner: area.owner, tree: area.tree, entry };
      }
      return null;
    },
    folderFor: (rowId) => {
      for (const area of areas) {
        const tree = area.tree;
        if (!tree) continue;
        if (rowId === area.id)
          return {
            scheme: area.scheme,
            owner: area.owner,
            path: "/",
            tree,
            entryId: tree.root.entryId,
            writable: area.writable,
          };
        const folder = menuEntryFor(tree, rowId);
        if (folder?.kind === "dir")
          return {
            scheme: area.scheme,
            owner: area.owner,
            path: folder.path,
            tree,
            entryId: rowId,
            writable: area.writable,
          };
      }
      return null;
    },
    areaWritable: (areaId) => areas.find((area) => area.id === areaId)?.writable ?? false,
    own: {
      tree: ownArea?.tree ?? null,
      writable: ownArea?.writable ?? false,
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
  const { works, nameOf } = useWorks(projectId);
  const workId = own?.owner.workId;
  const rootThreadId = own?.owner.rootThreadId;
  const work = workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  // A document's owner names its own area: the Work, or the chat whose Scratch it is.
  const lineageTitle = useLineageTitle(projectId, rootThreadId ? { rootThreadId } : null);
  const ownerName = work ? nameOf(work) : lineageTitle;
  if (!own) return "";
  return ownerName ? t`${schemeLabel(own.scheme)} for ${ownerName}` : schemeLabel(own.scheme);
}
