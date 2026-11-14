/**
 * The one reader of a project's tree: the replay of its list, a source at a time. A tree is the
 * list's replay cut to the source its scheme and owner name; the sources query says which source
 * that is. Whoever reads a name, a path or a place reads it here, so a rename shows in the tree,
 * the tabs, the identity bar and the pickers at once.
 */
import type {
  ContextSource,
  ProjectContextTreeScheme,
  TreeListRef,
} from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { dismissedFailures, useDismissalRevision } from "@/core/project-tree/failure-dismissals";
import { treeFailures } from "@/core/project-tree/tree-failures";
import { buildTreeView, type TreeFailure, type TreeView } from "@/core/project-tree/tree-view";
import type { TreeListHandle } from "@/core/tree-list/tree-list-registry";
import type {
  TreeListSession,
  TreeListSnapshot,
  TreeListStatus,
} from "@/core/tree-list/tree-list-session";
import {
  useAccountId,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { useAccountContextSources, useProjectContextSources } from "./useContextSources";

/** Whose source a view reads: a Work or lineage holds Scratch, and a chat holds its uploads. */
export type TreeOwner = {
  workId?: string | null;
  rootThreadId?: string | null;
  chatId?: string | null;
};

/**
 * The list's session and its snapshot, held while the caller is mounted. Null until the account's
 * lists are open (outside the authenticated shell there are none).
 */
export function useTreeList(list: TreeListRef | null): {
  session: TreeListSession | null;
  snapshot: TreeListSnapshot | null;
} {
  const registry = useOptionalTreeLists();
  const kind = list?.kind ?? null;
  const owner = list ? (list.kind === "project" ? list.projectId : list.userId) : null;
  // The handle is held while the caller is mounted on this list, and released with it.
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

/** A source's authority and id for a scheme and owner, or null when the sources do not hold one. */
export function sourceFor(
  sources: readonly ContextSource[],
  scheme: ProjectContextTreeScheme,
  owner: TreeOwner,
): ContextSource | null {
  const owns = (source: ContextSource): boolean => {
    const by = source.owner;
    if (by.kind === "project") return true;
    if (by.kind === "work")
      return scheme === "scratch" && !owner.rootThreadId && by.workId === owner.workId;
    if (by.kind === "lineage")
      return scheme === "scratch" && by.rootThreadId === owner.rootThreadId;
    return scheme === "uploads" && by.chatId === owner.chatId;
  };
  return sources.find((source) => source.scheme === scheme && owns(source)) ?? null;
}

const READY = new Set<TreeListStatus>(["synced", "read-only", "offline", "unauthenticated"]);

/** The copy has synced or can stand in for the list: an address that finds no node is "not there". */
export const listIsComplete = (status: TreeListStatus): boolean => READY.has(status);

export type TreeViewResult = {
  tree: TreeView | null;
  /** The list has synced or the copy can stand in for it: an address that finds no node is "not there". Otherwise it is "waiting for the list". */
  isComplete: boolean;
  /** This account has no access to the list. */
  isError: boolean;
};

const seenFailures = new WeakMap<TreeListSession, Map<string, number | null>>();

/** First sight of a refusal while the copy is still loading is not fresh (undefined); one that lands after is. */
function failureSeenAt(session: TreeListSession, status: TreeListStatus) {
  let seen = seenFailures.get(session);
  if (!seen) {
    seen = new Map();
    seenFailures.set(session, seen);
  }
  const map = seen;
  return (record: string) => {
    let at = map.get(record);
    if (at === undefined) {
      at = status === "waiting" ? null : Date.now();
      map.set(record, at);
    }
    return at ?? undefined;
  };
}

const failuresOfSnapshot = new WeakMap<
  TreeListSnapshot,
  { dismissals: number; failures: ReadonlyMap<string, TreeFailure> }
>();

/** The writer's refusals as the list stands, read once per version for every view that shows them. */
function failuresOf(
  session: TreeListSession,
  snapshot: TreeListSnapshot,
  accountId: string,
  dismissals: number,
): ReadonlyMap<string, TreeFailure> {
  const held = failuresOfSnapshot.get(snapshot);
  if (held?.dismissals === dismissals) return held.failures;
  const failures = treeFailures(
    snapshot.doc,
    `user:${accountId}`,
    dismissedFailures(accountId),
    failureSeenAt(session, snapshot.status),
    LIVE,
  );
  failuresOfSnapshot.set(snapshot, { dismissals, failures });
  return failures;
}

/** The trees of the schemes' sources, built from the lists' replays. */
export function useProjectTreeViews<S extends ProjectContextTreeScheme>(
  projectId: string,
  schemes: readonly S[],
  options: { enabled?: boolean } & TreeOwner,
): Record<S, TreeViewResult> {
  const { workId, rootThreadId, chatId } = options;
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
  const dismissals = useDismissalRevision();

  const owner = useMemo(() => ({ workId, rootThreadId, chatId }), [workId, rootThreadId, chatId]);

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
                projection: list.session.replay(),
                scheme,
                source,
                authority: source.authority,
                failures: failuresOf(list.session, snapshot, accountId, dismissals),
              })
            : null,
        isComplete: ready,
        isError: snapshot?.status === "denied",
      };
    }
    return results;
    // `version` is the replay's input: the copy changing is what rebuilds a view
  }, [
    schemes,
    account,
    project,
    account.snapshot?.version,
    project.snapshot?.version,
    accountSources,
    projectSources,
    owner,
    accountId,
    dismissals,
  ]);
}

export function useProjectTreeView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean } & TreeOwner,
): TreeViewResult {
  const schemes = useMemo(() => [scheme], [scheme]);
  return useProjectTreeViews(projectId, schemes, options)[scheme];
}

/** What an address found in a tree: a node, "not there", or "waiting for the list" while the copy has not synced. */
export type Resolved<T> = { kind: "found"; value: T } | { kind: "absent" } | { kind: "waiting" };

export function resolveIn<T>(
  result: TreeViewResult,
  find: (tree: TreeView) => T | null,
): Resolved<T> {
  const found = result.tree ? find(result.tree) : null;
  if (found) return { kind: "found", value: found };
  return result.isComplete ? { kind: "absent" } : { kind: "waiting" };
}
