import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type { CreateWorkRequest, UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  archiveWork,
  createProjectWork,
  deleteWork,
  listProjectWorks,
  unarchiveWork,
  updateWork,
  updateWorkWriteMode,
} from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && !useIsProjectPendingCreation(projectId);
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => listProjectWorks(projectId, { status: "all" }),
    staleTime: 30_000,
    enabled,
  });
  const works = list.data?.works ?? (list.isError ? [] : null);
  const newChatFallbackWorkId = list.data?.newChatFallbackWorkId ?? null;
  const refetch = useCallback(() => void list.refetch(), [list.refetch]);
  const status = !enabled
    ? "disabled"
    : list.isError
      ? "error"
      : !list.data
        ? "loading"
        : list.data.works.length === 0
          ? "empty"
          : "ready";
  return {
    works,
    newChatFallbackWorkId,
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}

export function useNewChatFallbackWorkId(projectId: string): string | null {
  return useWorks(projectId).newChatFallbackWorkId;
}

export function useWorkMutations(projectId: string) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (
      action:
        | { type: "create"; data: CreateWorkRequest }
        | { type: "update"; workId: string; data: UpdateWorkRequest }
        | { type: "archive" | "unarchive" | "delete"; workId: string },
    ) => {
      switch (action.type) {
        case "create":
          return createProjectWork(projectId, action.data);
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
    onSuccess: (result, action) => {
      if (result) {
        client.setQueryData<ListWorksResponse>(projectQueryKeys.works(projectId), (current) => {
          if (!current) return current;
          const present = current.works.some((work) => work.id === result.id);
          return {
            ...current,
            works: present
              ? current.works.map((work) => (work.id === result.id ? result : work))
              : [...current.works, result],
          };
        });
      }
      convergeWorkProjection(client, {
        kind: "entity",
        projectId,
        operation: action.type,
      });
    },
  });
  return mutation;
}

export type UpdateWorkWriteModeMutationInput =
  | Work["aiWriteMode"]
  | { aiWriteMode: Work["aiWriteMode"]; confirmedPush?: boolean };

export function useUpdateWorkWriteMode(projectId: string, workId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.works(projectId);
  return useMutation({
    mutationFn: (input: UpdateWorkWriteModeMutationInput) => {
      if (!workId) throw new Error("Cannot update write mode before a work is loaded");
      return updateWorkWriteMode(projectId, workId, input);
    },
    onSuccess: (result) => {
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
