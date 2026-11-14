/**
 * Every source's tree in one project, and where a document is now whichever source holds it: for a
 * reader that has only an id (a tab, a Recent row, the reference browser). A document's id never
 * changes, so a rename, a move or a delete made anywhere shows here at once; a document the list
 * does not show (in Trash, purged, never there) is not found, and `isComplete` says whether that
 * means "gone" or "the list has not synced yet".
 */
import type { ContextSource } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { buildTreeView, type TreeFile, type TreeView } from "@/core/project-tree/tree-view";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { useAccountContextSources, useProjectContextSources } from "./useContextSources";
import { listIsComplete, useTreeList } from "./useProjectTree";

export type DocumentPlace = { file: TreeFile; source: ContextSource };

export type ProjectTrees = {
  /** Every list asked for has synced or can be stood in for by its copy. */
  isComplete: boolean;
  /** An account has no access to a list asked for. */
  isError: boolean;
  sources: readonly ContextSource[];
  tree(sourceId: string): TreeView | null;
  find(documentId: string): DocumentPlace | null;
};

const WAITING: ProjectTrees = {
  isComplete: false,
  isError: false,
  sources: [],
  tree: () => null,
  find: () => null,
};

/** `account` adds the account's own list (`user://`). */
export function useProjectTrees(projectId: string, options?: { account?: boolean }): ProjectTrees {
  const wantsAccount = options?.account ?? false;
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList(wantsAccount ? { kind: "account", userId: accountId } : null);
  const projectSources = useProjectContextSources(projectId);
  const accountSources = useAccountContextSources(wantsAccount);
  return useMemo(() => {
    const lists = [
      { list: project, sources: projectSources },
      ...(wantsAccount ? [{ list: account, sources: accountSources }] : []),
    ];
    if (lists.some(({ list, sources }) => !list.session || !list.snapshot || !sources))
      return WAITING;
    const built = new Map<string, { source: ContextSource; tree: TreeView }>();
    const entries = lists.flatMap(({ list, sources }) => {
      const projection = list.session?.replay();
      if (!projection) return [];
      return (sources ?? []).map((source) => ({
        source,
        projection,
        node: (id: string) => projection.nodes.get(id),
      }));
    });
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
      isComplete: lists.every(({ list }) => listIsComplete(list.snapshot?.status ?? "waiting")),
      isError: lists.some(({ list }) => list.snapshot?.status === "denied"),
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
    };
    // `version` is the replay's input: the copy changing is what rebuilds the trees
  }, [
    project,
    account,
    project.snapshot?.version,
    account.snapshot?.version,
    projectSources,
    accountSources,
    wantsAccount,
  ]);
}
