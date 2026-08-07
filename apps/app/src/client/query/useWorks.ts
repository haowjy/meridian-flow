import type { CreateWorkRequest, UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  archiveWork,
  createProjectWork,
  deleteWork,
  getCurrentWork,
  listProjectWorks,
  setCurrentWork,
  unarchiveWork,
  updateWork,
  updateWorkWriteMode,
} from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && !useIsProjectPendingCreation(projectId);
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => listProjectWorks(projectId),
    staleTime: 30_000,
    enabled,
  });
  const current = useQuery({
    queryKey: projectQueryKeys.currentWork(projectId),
    queryFn: () => getCurrentWork(projectId),
    staleTime: 30_000,
    enabled,
  });
  return {
    works: list.data?.works ?? (list.isError ? [] : null),
    currentWork: current.data ?? null,
    currentWorkId: current.data?.id ?? null,
    // Context document placement historically calls this the default Work.
    defaultWorkId: current.data?.id ?? null,
    isError: list.isError || current.isError,
    isFetching: list.isFetching || current.isFetching,
    refetch: () => void Promise.all([list.refetch(), current.refetch()]),
  };
}

export function useDefaultWorkId(projectId: string): string | null {
  return useWorks(projectId).currentWorkId;
}

async function refreshWorks(client: QueryClient, projectId: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.currentWork(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) }),
  ]);
}

export function useWorkMutations(projectId: string) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (
      action:
        | { type: "create"; data: CreateWorkRequest }
        | { type: "switch"; workId: string }
        | { type: "update"; workId: string; data: UpdateWorkRequest }
        | { type: "archive" | "unarchive" | "delete"; workId: string },
    ) => {
      switch (action.type) {
        case "create":
          return createProjectWork(projectId, action.data);
        case "switch":
          return setCurrentWork(projectId, action.workId);
        case "update":
          return updateWork(action.workId, action.data);
        case "archive":
          return archiveWork(action.workId);
        case "unarchive":
          return unarchiveWork(action.workId);
        case "delete":
          await deleteWork(action.workId);
          return null;
      }
    },
    onSuccess: () => refreshWorks(client, projectId),
  });
  return mutation;
}

export type UpdateWorkWriteModeMutationInput =
  | Work["aiWriteMode"]
  | { aiWriteMode: Work["aiWriteMode"]; confirmedPush?: boolean };

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateWorkWriteModeMutationInput) => {
      if (!workId) throw new Error("Cannot update write mode before a work is loaded");
      return updateWorkWriteMode(projectId, workId, input);
    },
    onSuccess: () => {
      if (!workId) return;
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDrafts(projectId, workId),
      });
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.all });
    },
  });
}
