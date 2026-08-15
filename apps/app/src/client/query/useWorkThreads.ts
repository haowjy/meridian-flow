/** Typed React Query read seam for chats associated with one Work. */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listWorkThreads } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

export function useWorkThreads(
  projectId: string,
  workId: string,
  options?: { enabled?: boolean },
): {
  threads: ThreadListItem[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = (options?.enabled ?? true) && !isPendingCreation;
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.workThreads(projectId, workId),
      queryFn: () => listWorkThreads(workId),
      staleTime: 30_000,
      enabled,
    }),
  );

  return { threads: data, isError, isFetching, refetch };
}
