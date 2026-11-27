import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { listWorkDrafts } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { projectThreadsQueryOptions } from "./useProjectThreads";
import { useWorks, useWorksSnapshot } from "./useWorks";

export function useDraftStanding(
  projectId: string,
  draftId: string | null,
): "exists" | "gone" | null {
  const client = useQueryClient();
  const asked = useMemo(() => (draftId ? Date.now() : 0), [draftId]);
  const { works, deleted, creations } = useWorks(projectId, { enabled: !!draftId });
  const { list: worksList } = useWorksSnapshot(projectId, !!draftId);
  const threadsList = useQuery({
    ...projectThreadsQueryOptions(projectId),
    enabled: projectReadEnabled(!!draftId),
  });
  const namedCheaply =
    !!draftId &&
    ([...(works ?? []), ...deleted].some((work) => work.draftId === draftId) ||
      [...creations.values()].some(({ work }) => work.draftId === draftId) ||
      (threadsList.data ?? []).some((thread) => thread.draftId === draftId));
  const workDrafts = useQueries({
    queries: (works ?? []).map((work) => ({
      queryKey: projectQueryKeys.workDrafts(projectId, work.id),
      queryFn: () => listWorkDrafts(work.id),
      enabled: projectReadEnabled(!!draftId && !namedCheaply),
    })),
  });
  const named =
    namedCheaply ||
    workDrafts.some((read) => read.data?.drafts.some((draft) => draft.id === draftId));
  const fresh = (read: { dataUpdatedAt: number; isError: boolean }) =>
    read.dataUpdatedAt >= asked && !read.isError;
  const refetchWorks = worksList.refetch;
  const refetchThreads = threadsList.refetch;
  useEffect(() => {
    if (!draftId || named) return;
    if (worksList.dataUpdatedAt < asked && !worksList.isFetching) void refetchWorks();
    if (threadsList.dataUpdatedAt < asked && !threadsList.isFetching) void refetchThreads();
    for (const read of workDrafts)
      if (read.dataUpdatedAt < asked && !read.isFetching) void read.refetch();
  }, [draftId, named, asked, workDrafts]);
  if (!draftId) return null;
  if (named) return "exists";
  return works && fresh(worksList) && fresh(threadsList) && workDrafts.every(fresh) ? "gone" : null;
}
