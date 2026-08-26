import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type { CreateWorkRequest, UpdateWorkRequest, Work } from "@meridian/contracts/works";
import {
  type QueryClient,
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}

export function useWorkMutations(projectId: string) {
  const client = useQueryClient();
  const lifecycleScope = { id: `work-lifecycle:${projectId}` };
  const create = useWorkCommand(
    client,
    projectId,
    "create",
    (data: CreateWorkRequest) => createProjectWork(projectId, data),
    { projectResult: returnsWork },
  );
  const update = useWorkCommand(
    client,
    projectId,
    "update",
    ({ workId, data }: { workId: string; data: UpdateWorkRequest }) => updateWork(workId, data),
    { projectResult: returnsWork },
  );
  const archive = useWorkCommand(client, projectId, "archive", archiveWork, {
    projectResult: returnsWork,
    scope: lifecycleScope,
  });
  const unarchive = useWorkCommand(client, projectId, "unarchive", unarchiveWork, {
    projectResult: returnsWork,
    scope: lifecycleScope,
  });
  const remove = useWorkCommand(client, projectId, "delete", deleteWork, {
    scope: lifecycleScope,
  });
  const commands = [create, update, archive, unarchive, remove] as const;
  return {
    create,
    update,
    archive,
    unarchive,
    delete: remove,
    isPending: commands.some((command) => command.isPending),
    reset: () =>
      commands.forEach((command) => {
        command.reset();
      }),
  };
}

type WorkOperation = "create" | "update" | "archive" | "unarchive" | "delete";

const returnsWork = (work: Work) => work;

function useWorkCommand<TResult, TVariables>(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  command: (variables: TVariables) => Promise<TResult>,
  options: { projectResult?: (result: TResult) => Work; scope?: { id: string } } = {},
): UseMutationResult<TResult, Error, TVariables> {
  const mutation = useMutation({
    mutationFn: command,
    scope: options.scope,
    onSuccess: (result) =>
      convergeWorkCommand(client, projectId, operation, options.projectResult?.(result)),
  });
  return {
    ...mutation,
    reset: () => {
      if (!mutation.isPending) mutation.reset();
    },
  };
}

function convergeWorkCommand(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  result: Work | undefined,
): void {
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
  convergeWorkProjection(client, { kind: "entity", projectId, operation });
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
