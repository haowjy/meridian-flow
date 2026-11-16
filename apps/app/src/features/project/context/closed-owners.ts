import { parseDraftOwnerKey, type ThreadDraftListResponse } from "@meridian/contracts/branches";
import type { ContextSource } from "@meridian/contracts/protocol";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextSourceFacts, useProjectContextSources } from "@/client/query/useContextSources";
import { ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import { useWorks } from "@/client/query/useWorks";
import type { ClosedOwner, ClosedOwners } from "@/core/project-tree/tree-undo";

type Read = {
  works: readonly Work[] | null;
  deleted: readonly Work[];
  nameOf: (work: Work) => string;
  sources: readonly ContextSource[] | undefined;
  facts: { ended: ReadonlySet<string> } | null;
};

type Shared = {
  read: Read | null;
  /** The tab's read changed: each Work whose lifecycle it reads differently now is read as of now. */
  tell: () => void;
  reader: ClosedOwners;
};

const projects = new WeakMap<QueryClient, Map<string, Shared>>();

/**
 * Which owners this tab reads as closed, read at each press from what it holds now: the Works
 * list as this tab's own archive and unarchive left it, each lineage's draft list (`frozen`: every
 * chat in Trash), and the sources that ended. `readAt` is when the tab last learned an owner's
 * state: the list's fetch, or this tab's own change to that Work. One object per project for the
 * tab's life, kept current by every component that calls this: an Apply holds it long after the
 * component that applied it is gone.
 */
export function useClosedOwners(projectId: string): ClosedOwners {
  const queryClient = useQueryClient();
  const { works, deleted, nameOf } = useWorks(projectId, { enabled: Boolean(projectId) });
  const sources = useProjectContextSources(projectId);
  const facts = useContextSourceFacts(projectId);
  const shared = sharedOf(queryClient, projectId);
  shared.read = { works, deleted, nameOf, sources, facts };
  // The Works list and the sources are read here: a new read is a change.
  useEffect(() => shared.tell(), [shared, works, deleted, sources, facts]);
  return shared.reader;
}

function sharedOf(queryClient: QueryClient, projectId: string): Shared {
  let byProject = projects.get(queryClient);
  if (!byProject) {
    byProject = new Map();
    projects.set(queryClient, byProject);
  }
  const found = byProject.get(projectId);
  if (found) return found;
  const listeners = new Set<() => void>();
  // Each Work's lifecycle as last read, and when the read last changed.
  const lifecycles = new Map<string, { state: string; at: number }>();
  const shared: Shared = {
    read: null,
    tell: () => {
      const { works, deleted } = shared.read ?? {};
      for (const work of [...(works ?? []), ...(deleted ?? [])]) {
        const state = workLifecycleState(work);
        if (lifecycles.get(work.id)?.state !== state)
          lifecycles.set(work.id, { state, at: Date.now() });
      }
      for (const listener of [...listeners]) listener();
    },
    reader: {
      source: (sourceId) => {
        const { sources, facts } = shared.read ?? {};
        if (facts?.ended.has(sourceId)) return { why: "chat_frozen" };
        const source = sources?.find((one) => one.id === sourceId);
        return source ? ownerOf(source) : null;
      },
      owner: (ownerKey) => {
        const parsed = parseDraftOwnerKey(ownerKey);
        if (!parsed) return false;
        return parsed.kind === "work" ? workClosed(parsed.id) !== null : lineageClosed(parsed.id);
      },
      readAt: (ownerKey) => {
        const parsed = parseDraftOwnerKey(ownerKey);
        if (!parsed) return 0;
        const fetched =
          queryClient.getQueryState(
            parsed.kind === "work"
              ? projectQueryKeys.works(projectId)
              : projectQueryKeys.ownerDrafts(projectId, ownerKey),
          )?.dataUpdatedAt ?? 0;
        return parsed.kind === "work"
          ? Math.max(fetched, lifecycles.get(parsed.id)?.at ?? 0)
          : fetched;
      },
      refresh: (ownerKeys) => {
        for (const ownerKey of ownerKeys) {
          const parsed = parseDraftOwnerKey(ownerKey);
          if (parsed?.kind === "work")
            void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
          // A lineage's list may have no reader on screen: fetch it, so `frozen` is known here.
          else if (parsed?.kind === "lineage")
            void queryClient
              .fetchQuery({ ...ownerDraftsQueryOptions(projectId, ownerKey), staleTime: 0 })
              .catch(() => undefined);
        }
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const workClosed = (workId: string): ClosedOwner | null => {
    const { works, deleted, nameOf } = shared.read ?? {};
    const work = [...(works ?? []), ...(deleted ?? [])].find((one) => one.id === workId);
    if (!work || !nameOf) return null;
    const state = workLifecycleState(work);
    return state === "active"
      ? null
      : { why: state === "deleted" ? "work_deleted" : "work_archived", owner: nameOf(work) };
  };
  const lineageClosed = (rootThreadId: string): boolean =>
    queryClient.getQueryData<ThreadDraftListResponse>(
      projectQueryKeys.ownerDrafts(projectId, `lineage:${rootThreadId}`),
    )?.frozen ?? false;
  const ownerOf = (source: ContextSource): ClosedOwner | null => {
    const { owner } = source;
    if (owner.kind === "work") return workClosed(owner.workId);
    if (owner.kind === "lineage")
      return lineageClosed(owner.rootThreadId) ? { why: "chat_frozen" } : null;
    return null;
  };
  // A lineage's `frozen` arrives with its draft list, which another surface reads.
  queryClient.getQueryCache().subscribe((event) => {
    const [, project, kind, owner] = event.query.queryKey as unknown[];
    if (
      event.type === "updated" &&
      project === projectId &&
      kind === "drafts" &&
      typeof owner === "string" &&
      owner.startsWith("lineage:")
    )
      shared.tell();
  });
  byProject.set(projectId, shared);
  return shared;
}
