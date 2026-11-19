import type { ThreadDraftListResponse } from "@meridian/contracts/branches";
import type { ContextSource } from "@meridian/contracts/protocol";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextSourceFacts, useProjectContextSources } from "@/client/query/useContextSources";
import { useWorks } from "@/client/query/useWorks";
import type { ClosedOwner, ClosedOwners } from "@/core/project-tree/tree-undo";

type Read = {
  works: readonly Work[] | null;
  deleted: readonly Work[];
  nameOf: (work: Work) => string;
  sources: readonly ContextSource[] | undefined;
  facts: { ended: ReadonlySet<string> } | null;
};

type Shared = { read: Read | null; reader: ClosedOwners };

const projects = new WeakMap<QueryClient, Map<string, Shared>>();

/**
 * Which owners this tab reads as closed, read at each press from what it holds now: the Works
 * list as this tab's own archive and unarchive left it, each lineage's draft list (`frozen`: every
 * chat in Trash), and the sources that ended. One object per project for the tab's life, kept
 * current by every component that calls this: a step on the sidebar's stack holds it long after
 * the component that made it is gone.
 */
export function useClosedOwners(projectId: string): ClosedOwners {
  const queryClient = useQueryClient();
  const { works, deleted, nameOf } = useWorks(projectId, { enabled: Boolean(projectId) });
  const sources = useProjectContextSources(projectId);
  const facts = useContextSourceFacts(projectId);
  const shared = sharedOf(queryClient, projectId);
  shared.read = { works, deleted, nameOf, sources, facts };
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
  const shared: Shared = {
    read: null,
    reader: {
      source: (sourceId) => {
        const { sources, facts } = shared.read ?? {};
        if (facts?.ended.has(sourceId)) return { why: "chat_frozen" };
        const source = sources?.find((one) => one.id === sourceId);
        return source ? ownerOf(source) : null;
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
  byProject.set(projectId, shared);
  return shared;
}
