import type { CreateWorkRequest, UpdateWorkRequest, Work } from "@meridian/contracts/works";
import {
  type QueryClient,
  type UseMutateAsyncFunction,
  type UseMutateFunction,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";

import {
  archiveWork,
  createProjectWork,
  deleteWork,
  restoreWork,
  unarchiveWork,
  updateWork,
  updateWorkWriteMode,
} from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";
import { acquireWorksSnapshot, repairWorksSnapshot } from "./works-projection-acquisition";

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && !useIsProjectPendingCreation(projectId);
  const listClient = useQueryClient();
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => acquireWorksSnapshot(listClient, projectId),
    staleTime: 30_000,
    enabled,
  });
  const works =
    list.data?.works.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null);
  const refetch = useCallback(() => void list.refetch(), [list.refetch]);
  const status = !enabled
    ? "disabled"
    : list.isError
      ? "error"
      : !list.data
        ? "loading"
        : works?.length === 0
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

export interface WorkCommand<TResult, TVariables> {
  mutate: UseMutateFunction<TResult, Error, TVariables>;
  mutateAsync: UseMutateAsyncFunction<TResult, Error, TVariables>;
  isPending: boolean;
  error: Error | null;
}

export interface WorkMutations {
  create: WorkCommand<Work, CreateWorkRequest>;
  update: WorkCommand<Work, { workId: string; data: UpdateWorkRequest }>;
  archive: WorkCommand<Work, string>;
  unarchive: WorkCommand<Work, string>;
  delete: WorkCommand<void, string>;
  restore: WorkCommand<Work, string>;
  isPending: boolean;
}

export function useWorkMutations(projectId: string): WorkMutations {
  const client = useQueryClient();
  const lifecycleScope = { id: `work-lifecycle:${projectId}` };
  const create = useWorkCommand(client, projectId, "create", (data: CreateWorkRequest) =>
    createProjectWork(projectId, data),
  );
  const update = useWorkCommand(
    client,
    projectId,
    "update",
    ({ workId, data }: { workId: string; data: UpdateWorkRequest }) => updateWork(workId, data),
  );
  const archive = useWorkCommand(client, projectId, "archive", archiveWork, {
    scope: lifecycleScope,
  });
  const unarchive = useWorkCommand(client, projectId, "unarchive", unarchiveWork, {
    scope: lifecycleScope,
  });
  const remove = useWorkCommand(client, projectId, "delete", deleteWork, {
    scope: lifecycleScope,
  });
  const restore = useWorkCommand(client, projectId, "restore", restoreWork, {
    scope: lifecycleScope,
  });
  const commands = [create, update, archive, unarchive, remove, restore] as const;
  return {
    create,
    update,
    archive,
    unarchive,
    delete: remove,
    restore,
    isPending: commands.some((command) => command.isPending),
  };
}

type WorkOperation = "create" | "update" | "archive" | "unarchive" | "delete" | "restore";

function useWorkCommand<TResult, TVariables>(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  command: (variables: TVariables) => Promise<TResult>,
  options: { scope?: { id: string } } = {},
): WorkCommand<TResult, TVariables> {
  const mutation = useMutation<TResult, Error, TVariables>({
    mutationFn: command,
    scope: options.scope,
    onSuccess: () => convergeWorkCommand(client, projectId, operation),
  });
  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}

function convergeWorkCommand(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
): Promise<void> {
  convergeWorkProjection(client, { kind: "entity", projectId, operation });
  return repairWorksSnapshot(client, projectId);
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
    onSuccess: async (result) => {
      if (!workId) return;
      invalidateWorkPushQueries(queryClient, projectId, workId);
      if (result.status !== "updated") return;
      await repairWorksSnapshot(queryClient, projectId);
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
