import type { ContextOwner, ContextSource } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { LIVE_VERSION, type TreeVersion } from "@/core/project-tree/tree-version";
import { buildTreeView, type TreeFile, type TreeView } from "@/core/project-tree/tree-view";
import { type DocumentStanding, standingAcross } from "@/core/tree-list/standing";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useAccountContextSources, useProjectContextSources } from "./useContextSources";
import { listIsComplete, useTreeList } from "./useProjectTree";

export function ownerOfSource({ owner }: ContextSource): ContextOwner {
  if (owner.kind === "work") return { workId: owner.workId };
  if (owner.kind === "lineage") return { rootThreadId: owner.rootThreadId };
  if (owner.kind === "chat") return { chatThreadId: owner.chatId };
  return {};
}

export type DocumentPlace = { file: TreeFile; source: ContextSource };

export type ProjectTrees = {
  ready: boolean;
  isComplete: boolean;
  isError: boolean;
  sources: readonly ContextSource[];
  tree(sourceId: string): TreeView | null;
  find(documentId: string): DocumentPlace | null;
  standing(documentId: string): DocumentStanding;
};

const WAITING: ProjectTrees = {
  ready: false,
  isComplete: false,
  isError: false,
  sources: [],
  tree: () => null,
  find: () => null,
  standing: () => ({ kind: "waiting" }),
};

export function useProjectTrees(
  projectId: string,
  options?: { version?: TreeVersion },
): ProjectTrees {
  const { view } = options?.version ?? LIVE_VERSION;
  const at = useProjectTreesAt(projectId);
  return useMemo(() => at(view), [at, view]);
}

export function useProjectTreesAt(projectId: string): (view: TreeVersion["view"]) => ProjectTrees {
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList({ kind: "account", userId: accountId });
  const projectSources = useProjectContextSources(projectId);
  const accountSources = useAccountContextSources();
  return useMemo(() => {
    const projectTreesIn = (view: TreeVersion["view"]): ProjectTrees => {
      const lists = [
        { list: project, sources: projectSources },
        { list: account, sources: accountSources },
      ].flatMap(({ list: { session, snapshot }, sources }) =>
        session && snapshot && sources
          ? [{ snapshot, sources, projection: session.replay(view) }]
          : [],
      );
      const [inProject, inAccount] = lists;
      if (!inProject || !inAccount) return WAITING;
      const built = new Map<string, { source: ContextSource; tree: TreeView }>();
      const entries = lists.flatMap(({ sources, projection }) =>
        sources.map((source) => ({
          source,
          projection,
          node: (id: string) => projection.nodes.get(id),
        })),
      );
      const treeOf = (entry: (typeof entries)[number]): TreeView => {
        let held = built.get(entry.source.id);
        if (!held) {
          held = {
            source: entry.source,
            tree: buildTreeView({
              projection: entry.projection,
              scheme: entry.source.scheme,
              source: entry.source,
              authority: entry.source.authority,
            }),
          };
          built.set(entry.source.id, held);
        }
        return held.tree;
      };
      return {
        ready: true,
        isComplete: lists.every(({ snapshot }) => listIsComplete(snapshot.status)),
        isError: lists.some(({ snapshot }) => snapshot.status === "denied"),
        sources: entries.map((entry) => entry.source),
        tree: (sourceId) => {
          const entry = entries.find((candidate) => candidate.source.id === sourceId);
          return entry ? treeOf(entry) : null;
        },
        find: (documentId) => {
          for (const entry of entries) {
            const node = entry.node(documentId);
            if (!node || node.source !== entry.source.id) continue;
            const file = treeOf(entry).findDocument(documentId);
            if (file) return { file, source: entry.source };
          }
          return null;
        },
        standing: (documentId) => standingAcross(inProject, inAccount, documentId),
      };
    };
    const read = new Map<TreeVersion["view"], ProjectTrees>();
    return (view: TreeVersion["view"]) => {
      const held = read.get(view) ?? projectTreesIn(view);
      read.set(view, held);
      return held;
    };
  }, [
    project,
    account,
    project.snapshot?.version,
    account.snapshot?.version,
    projectSources,
    accountSources,
  ]);
}
