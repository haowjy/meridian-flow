import type { UpdateWorkWriteModeRequest, Work } from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjectWorks, updateWorkWriteMode } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

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

export type UpdateWorkWriteModeMutationInput = Work["aiWriteMode"] | UpdateWorkWriteModeRequest;

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.works(projectId);

  return useMutation({
    mutationFn: (input: UpdateWorkWriteModeMutationInput) => {
      if (!workId) throw new Error("Cannot update write mode before a work is loaded");
      return updateWorkWriteMode(projectId, workId, input);
    },
    onSuccess: (result) => {
      // when result.status === "confirmation_required",
      // result.pendingChangeCount is the server-vended denominator for the
      // Auto-apply confirmation popover and the follow-up confirmedPush call.
      if (!workId) return;
      invalidateWorkPushQueries(queryClient, projectId, workId);
      if (result.status !== "updated") return;
      queryClient.setQueryData<Work[]>(queryKey, (current) =>
        current?.map((work) =>
          work.id === workId ? { ...work, aiWriteMode: result.aiWriteMode } : work,
        ),
      );
    },
  });
}

function invalidateWorkPushQueries(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.workDrafts(projectId, workId) });
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.all });
  void queryClient.invalidateQueries({
    queryKey: ["projects", projectId, "works", workId, "documents"],
  });
}
