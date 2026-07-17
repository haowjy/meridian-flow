import type {
  ListWorksResponse,
  UpdateWorkWriteModeRequest,
  Work,
} from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjectWorks, updateWorkWriteMode } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

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
  defaultWorkId: string | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = callerEnabled && !isPendingCreation;
  const { data, isError, isFetching, isPending, refetch } = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => listProjectWorks(projectId),
    staleTime: 30_000,
    enabled,
  });
  const works = data?.works ?? (isError ? [] : isPending || isFetching ? null : []);

  return {
    works,
    defaultWorkId: data?.defaultWorkId ?? null,
    isError,
    isFetching,
    refetch: () => void refetch(),
  };
}

/** Client seam for work-scoped surfaces that exist without a selected chat. */
export function useDefaultWorkId(projectId: string): string | null {
  return useWorks(projectId).defaultWorkId;
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
      queryClient.setQueryData<ListWorksResponse>(queryKey, (current) =>
        current
          ? {
              ...current,
              works: current.works.map((work) =>
                work.id === workId ? { ...work, aiWriteMode: result.aiWriteMode } : work,
              ),
            }
          : current,
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
