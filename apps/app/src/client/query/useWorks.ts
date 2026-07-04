import type { Work } from "@meridian/contracts/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjectWorks, updateWorkWriteMode } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

/**
 * Work items belonging to a single project. `null` = not loaded yet,
 * `[]` = loaded empty.
 *
 * The query is suppressed while the project is still pending optimistic
 * creation on the server; otherwise the request races `POST /api/projects`
 * and 404s during a normal flow.
 */
export function useWorks(
  projectId: string,
  options?: { enabled?: boolean },
): {
  works: Work[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = callerEnabled && !isPendingCreation;
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.works(projectId),
      queryFn: () => listProjectWorks(projectId),
      staleTime: 30_000,
      enabled,
    }),
  );

  return { works: data, isError, isFetching, refetch };
}

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.works(projectId);

  return useMutation({
    mutationFn: (aiWriteMode: Work["aiWriteMode"]) => {
      if (!workId) throw new Error("Cannot update write mode before a work is loaded");
      return updateWorkWriteMode(projectId, workId, aiWriteMode);
    },
    onSuccess: (result) => {
      if (result.status !== "updated" || !workId) return;
      queryClient.setQueryData<Work[]>(queryKey, (current) =>
        current?.map((work) =>
          work.id === workId ? { ...work, aiWriteMode: result.aiWriteMode } : work,
        ),
      );
    },
  });
}
