import type {
  ContextSource,
  ProjectContextTreeScheme,
  TreeListRef,
} from "@meridian/contracts/protocol";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useOptionalTreeLists } from "@/client/account/account-composition";
import { useAccountId } from "@/client/account/account-context";
import { LIVE_VERSION, type TreeVersion } from "@/core/project-tree/tree-version";
import { buildTreeView, type TreeView } from "@/core/project-tree/tree-view";
import type { TreeListHandle } from "@/core/tree-list/tree-list-registry";
import type {
  TreeListSession,
  TreeListSnapshot,
  TreeListStatus,
} from "@/core/tree-list/tree-list-session";
import { useAccountContextSources, useProjectContextSources } from "./useContextSources";

export type TreeOwner = {
  [K in "workId" | "rootThreadId" | "chatThreadId"]?: string | null;
};

export function useTreeList(list: TreeListRef | null): {
  session: TreeListSession | null;
  snapshot: TreeListSnapshot | null;
} {
  const registry = useOptionalTreeLists();
  const kind = list?.kind ?? null;
  const owner = list ? (list.kind === "project" ? list.projectId : list.userId) : null;
  const [held, setHeld] = useState<TreeListHandle | null>(null);
  useEffect(() => {
    if (!registry || !kind || !owner) {
      setHeld(null);
      return;
    }
    const handle = registry.acquire(
      kind === "project" ? { kind, projectId: owner } : { kind, userId: owner },
    );
    setHeld(handle);
    return () => {
      handle.release();
      setHeld(null);
    };
  }, [registry, kind, owner]);
  const session = held?.session ?? null;
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
    [session],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => session?.getSnapshot() ?? null,
    () => null,
  );
  return useMemo(() => ({ session, snapshot }), [session, snapshot]);
}

export function sourceFor(
  sources: readonly ContextSource[],
  scheme: ProjectContextTreeScheme,
  owner: TreeOwner,
): ContextSource | null {
  const owns = (source: ContextSource): boolean => {
    const by = source.owner;
    if (by.kind === "project" || by.kind === "account") return true;
    if (by.kind === "work")
      return scheme === "scratch" && !owner.rootThreadId && by.workId === owner.workId;
    if (by.kind === "lineage")
      return scheme === "scratch" && by.rootThreadId === owner.rootThreadId;
    return scheme === "uploads" && by.chatId === owner.chatThreadId;
  };
  return sources.find((source) => source.scheme === scheme && owns(source)) ?? null;
}

const READY = new Set<TreeListStatus>(["synced", "offline", "broken", "unauthenticated"]);

export const listIsComplete = (status: TreeListStatus): boolean => READY.has(status);

export type TreeViewResult = {
  tree: TreeView | null;
  isComplete: boolean;
  isError: boolean;
};

export function useProjectTreeViews<S extends ProjectContextTreeScheme>(
  projectId: string,
  schemes: readonly S[],
  options: { enabled?: boolean; version?: TreeVersion } & TreeOwner,
): Record<S, TreeViewResult> {
  const { workId, rootThreadId, chatThreadId } = options;
  const { view } = options.version ?? LIVE_VERSION;
  const enabled = (options.enabled ?? true) && Boolean(projectId);
  const accountId = useAccountId();
  const wantsAccount = schemes.includes("user" as S);
  const wantsProject = schemes.some((scheme) => scheme !== "user");
  const project = useTreeList(enabled && wantsProject ? { kind: "project", projectId } : null);
  const account = useTreeList(
    enabled && wantsAccount ? { kind: "account", userId: accountId } : null,
  );
  const projectSources = useProjectContextSources(enabled && wantsProject ? projectId : "");
  const accountSources = useAccountContextSources(enabled && wantsAccount);

  const owner = useMemo(
    () => ({ workId, rootThreadId, chatThreadId }),
    [workId, rootThreadId, chatThreadId],
  );

  return useMemo(() => {
    const results = {} as Record<S, TreeViewResult>;
    for (const scheme of schemes) {
      const list = scheme === "user" ? account : project;
      const sources = scheme === "user" ? accountSources : projectSources;
      const source = sources ? sourceFor(sources, scheme, owner) : null;
      const snapshot = list.snapshot;
      const ready = snapshot !== null && listIsComplete(snapshot.status) && sources !== undefined;
      results[scheme] = {
        tree:
          list.session && snapshot && source
            ? buildTreeView({
                projection: list.session.replay(view),
                scheme,
                source,
                authority: source.authority,
              })
            : null,
        isComplete: ready,
        isError: snapshot?.status === "denied",
      };
    }
    return results;
  }, [
    schemes,
    account,
    project,
    account.snapshot?.version,
    project.snapshot?.version,
    accountSources,
    projectSources,
    owner,
    view,
  ]);
}

export function useProjectTreeView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean; version?: TreeVersion } & TreeOwner,
): TreeViewResult {
  const schemes = useMemo(() => [scheme], [scheme]);
  return useProjectTreeViews(projectId, schemes, options)[scheme];
}

export type Resolved<T> = { kind: "found"; value: T } | { kind: "absent" } | { kind: "waiting" };

export function resolveIn<T>(
  result: TreeViewResult,
  find: (tree: TreeView) => T | null,
): Resolved<T> {
  const found = result.tree ? find(result.tree) : null;
  if (found) return { kind: "found", value: found };
  return result.isComplete ? { kind: "absent" } : { kind: "waiting" };
}
