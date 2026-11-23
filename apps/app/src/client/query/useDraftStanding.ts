import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { projectReadEnabled } from "./project-read-gate";
import { projectThreadsQueryOptions } from "./useProjectThreads";
import { useWorks, useWorksSnapshot } from "./useWorks";

/**
 * Whether the project still has a draft: a Work names it (a deleted one too, until its purge deletes
 * the draft), a Work being created does, or a chat does. The server lists an id it doesn't store
 * as empty, since a browser mints one before its create lands, so the list can't say. `gone` only
 * once both lists were read after this asked and neither names it; null until then, and while a
 * read fails (offline, a link keeps its draft).
 */
export function useDraftStanding(
  projectId: string,
  draftId: string | null,
): "exists" | "gone" | null {
  const client = useQueryClient();
  const asked = useMemo(() => (draftId ? Date.now() : 0), [draftId]);
  const { works, deleted, creations } = useWorks(projectId, { enabled: !!draftId });
  const { list: worksList } = useWorksSnapshot(projectId, !!draftId);
  const threadsList = useQuery({
    ...projectThreadsQueryOptions(client, projectId),
    enabled: projectReadEnabled(!!draftId),
  });
  const named =
    !!draftId &&
    ([...(works ?? []), ...deleted].some((work) => work.draftId === draftId) ||
      [...creations.values()].some(({ work }) => work.draftId === draftId) ||
      (threadsList.data ?? []).some((thread) => thread.draftId === draftId));
  const worksFresh = worksList.dataUpdatedAt >= asked && !worksList.isError;
  const threadsFresh = threadsList.dataUpdatedAt >= asked && !threadsList.isError;
  const refetchWorks = worksList.refetch;
  const refetchThreads = threadsList.refetch;
  useEffect(() => {
    if (!draftId || named) return;
    if (worksList.dataUpdatedAt < asked && !worksList.isFetching) void refetchWorks();
    if (threadsList.dataUpdatedAt < asked && !threadsList.isFetching) void refetchThreads();
  }, [draftId, named, asked]);
  if (!draftId) return null;
  if (named) return "exists";
  return worksFresh && threadsFresh ? "gone" : null;
}
