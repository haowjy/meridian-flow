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
  loadState(trail: readonly DrillNode[]): "ready" | "loading" | "failed";
  locate(id: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    tree: TreeView;
    entry: TreeEntry;
  } | null;
  folderFor(rowId: string): {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    path: string;
    tree: TreeView;
    entryId: string;
    writable: boolean;
  } | null;
  areaWritable(areaId: string): boolean;
  own: {
    tree: TreeView | null;
    writable: boolean;
    openAt(path: string): DrillNode[];
    openInside(folders: readonly string[]): DrillNode[];
    crumbTrail(path: string, depth: number): DrillNode[];
  };
};

export function useProjectMenuSource({
  projectId,
  title,
  scratch,
  own,
}: {
  projectId: string;
  title: string;
  scratch: ScratchSource | null;
  own: {
    scheme: ProjectContextTreeScheme;
    owner: ContextOwner;
    heading: string;
  } | null;
}): ProjectMenuSource {
  const version = useTreeVersion();
  const projectViews = useProjectTreeViews(projectId, EDITOR_CONTEXT_SCHEMES, {
    workId: null,
    version,
  });
  const { primary, earlier } = useScratchTrees(projectId, scratch);
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

export function useOwnAreaHeading(
  projectId: string,
  own: { scheme: ProjectContextTreeScheme; owner: ContextOwner } | null,
): string {
  const { works, nameOf } = useWorks(projectId);
  const workId = own?.owner.workId;
  const rootThreadId = own?.owner.rootThreadId;
  const work = workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  const lineageTitle = useLineageTitle(projectId, rootThreadId ? { rootThreadId } : null);
  const ownerName = work ? nameOf(work) : lineageTitle;
  if (!own) return "";
  return ownerName ? t`${schemeLabel(own.scheme)} for ${ownerName}` : schemeLabel(own.scheme);
}
