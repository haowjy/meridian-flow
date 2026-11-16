import { parseDraftOwnerKey, type ThreadDraftListResponse } from "@meridian/contracts/branches";
import type { ContextSource } from "@meridian/contracts/protocol";
import { type Work, workLifecycleState } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextSourceFacts, useProjectContextSources } from "@/client/query/useContextSources";
import { useWorks } from "@/client/query/useWorks";
import type { ClosedOwner, ClosedOwners } from "@/core/project-tree/tree-undo";

/**
 * Which owners this tab reads as closed, read at each press from what it holds now: the Works
 * list as this tab's own archive and unarchive left it, each lineage's draft list (`frozen`: every
 * chat in Trash), and the sources that ended. One object for the project's life.
 */
export function useClosedOwners(projectId: string): ClosedOwners {
  const queryClient = useQueryClient();
  const { works, deleted, nameOf } = useWorks(projectId, { enabled: Boolean(projectId) });
  const sources = useProjectContextSources(projectId);
  const facts = useContextSourceFacts(projectId);
  const now = useRef({ works, deleted, nameOf, sources, facts });
  now.current = { works, deleted, nameOf, sources, facts };
  return useMemo(() => {
    const workClosed = (workId: string): ClosedOwner | null => {
      const { works, deleted, nameOf } = now.current;
      const work: Work | undefined = [...(works ?? []), ...deleted].find(
        (one) => one.id === workId,
      );
      if (!work) return null;
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
    return {
      source: (sourceId) => {
        const { sources, facts } = now.current;
        if (facts?.ended.has(sourceId)) return { why: "chat_frozen" };
        const source = sources?.find((one) => one.id === sourceId);
        return source ? ownerOf(source) : null;
      },
      owner: (ownerKey) => {
        const parsed = parseDraftOwnerKey(ownerKey);
        if (!parsed) return false;
        return parsed.kind === "work" ? workClosed(parsed.id) !== null : lineageClosed(parsed.id);
      },
    };
  }, [queryClient, projectId]);
}
