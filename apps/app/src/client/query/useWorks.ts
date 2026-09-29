import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import {
  type QueryClient,
  replaceEqualDeep,
  type UseMutateAsyncFunction,
  type UseMutateFunction,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  archiveWork,
  deleteWork,
  restoreWork,
  unarchiveWork,
  updateWork,
  updateWorkWriteMode,
} from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { useIsProjectPendingCreation } from "./useProjectCreation";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  acquireWorksSnapshot,
  beginWorksSnapshotRequest,
  repairWorksSnapshot,
  seedWorksSnapshot,
  workFromSnapshot,
} from "./works-projection-acquisition";

export { workFromSnapshot };

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const enabled = (options?.enabled ?? true) && !useIsProjectPendingCreation(projectId);
  const listClient = useQueryClient();
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => acquireWorksSnapshot(listClient, projectId),
    staleTime: 30_000,
    enabled,
  });
  const works = useMemo(
    () => list.data?.works.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null),
    [list.data?.works, list.isError],
  );
  // Soft-deleted Works stay restorable until their purge date; newest first.
  const deleted = useMemo(
    () =>
      (list.data?.works.filter((work) => work.deletedAt !== null) ?? []).sort((a, b) =>
        (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
      ),
    [list.data?.works],
  );
  const noWork = list.data?.noWork ?? null;
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
    deleted,
    noWork,
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
  update: WorkCommand<Work, { workId: string; data: UpdateWorkRequest }>;
  archive: WorkCommand<Work, string>;
  unarchive: WorkCommand<Work, string>;
  delete: WorkCommand<void, string>;
  restore: WorkCommand<Work, string>;
}

export function useWorkMutations(projectId: string): WorkMutations {
  const client = useQueryClient();
  const lifecycleScope = { id: `work-lifecycle:${projectId}` };
  const update = useWorkCommand(
    client,
    projectId,
    "update",
    ({ workId, data }: { workId: string; data: UpdateWorkRequest }) => updateWork(workId, data),
    {
      optimistic: (snapshot, { workId, data }) =>
        patchSnapshotWork(snapshot, workId, { ...data, updatedAt: new Date().toISOString() }),
      confirmed: true,
    },
  );
  const archive = useWorkCommand(
    client,
    projectId,
    "archive",
    (workId: string) => archiveWork(workId),
    {
      scope: lifecycleScope,
      optimistic: (snapshot, workId) =>
        patchSnapshotWork(snapshot, workId, {
          status: "archived",
          archivedAt: new Date().toISOString(),
        }),
      confirmed: true,
    },
  );
  const unarchive = useWorkCommand(
    client,
    projectId,
    "unarchive",
    (workId: string) => unarchiveWork(workId),
    {
      scope: lifecycleScope,
      optimistic: (snapshot, workId) =>
        patchSnapshotWork(snapshot, workId, { status: "active", archivedAt: null }),
      confirmed: true,
    },
  );
  const remove = useWorkCommand(
    client,
    projectId,
    "delete",
    (workId: string) => deleteWork(workId),
    {
      scope: lifecycleScope,
    },
  );
  const restore = useWorkCommand(
    client,
    projectId,
    "restore",
    (workId: string) => restoreWork(workId),
    {
      scope: lifecycleScope,
      confirmed: true,
    },
  );
  return { update, archive, unarchive, delete: remove, restore };
}

type WorkOperation = "update" | "archive" | "unarchive" | "delete" | "restore";

/** Projects a command's expected result into the snapshot until the server answers. */
type OptimisticWorkPatch<TVariables> = (
  snapshot: WorksSnapshot,
  variables: TVariables,
) => WorksSnapshot;

type OptimisticContext = { previous: WorksSnapshot; optimistic: WorksSnapshot } | undefined;

function patchSnapshotWork(
  snapshot: WorksSnapshot,
  workId: string,
  fields: Partial<Work>,
): WorksSnapshot {
  const patch = <T extends Work>(work: T): T =>
    work.id === workId ? ({ ...work, ...fields } as T) : work;
  return { ...snapshot, works: snapshot.works.map(patch), noWork: patch(snapshot.noWork) };
}

/**
 * Undoes one command's projection entry by entry. Lifecycle commands queue in
 * one scope, so a later command's projection (or server truth that arrived
 * since) may sit beside this one; only Works still showing exactly this
 * projection return to their prior value.
 */
function revertOptimistic(
  current: WorksSnapshot,
  { previous, optimistic }: NonNullable<OptimisticContext>,
): WorksSnapshot {
  const before = new Map([...previous.works, previous.noWork].map((work) => [work.id, work]));
  const projected = new Map(
    [...optimistic.works, optimistic.noWork].map((work) => [work.id, work]),
  );
  const revert = <T extends Work>(work: T): T => {
    const prior = before.get(work.id);
    const mine = projected.get(work.id);
    if (!prior || !mine || mine === prior) return work;
    // Deep-equal check: the query cache structurally shares, so identity is lost.
    return replaceEqualDeep(mine, work) === mine ? (prior as T) : work;
  };
  return { ...current, works: current.works.map(revert), noWork: revert(current.noWork) };
}

function useWorkCommand<TResult, TVariables>(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  command: (variables: TVariables) => Promise<TResult>,
  options: {
    scope?: { id: string };
    optimistic?: OptimisticWorkPatch<TVariables>;
    /** The command answers with the Work as committed; install it at once. */
    confirmed?: TResult extends Work ? true : never;
  } = {},
): WorkCommand<TResult, TVariables> {
  const { optimistic, confirmed } = options;
  const queryKey = projectQueryKeys.works(projectId);
  const mutation = useMutation<TResult, Error, TVariables, OptimisticContext>({
    mutationKey: workCommandKey(projectId),
    mutationFn: command,
    scope: options.scope,
    // A scoped command waits for its turn on the network, but onMutate runs at
    // once, so the writer sees every queued command immediately.
    onMutate: optimistic
      ? async (variables): Promise<OptimisticContext> => {
          await client.cancelQueries({ queryKey, exact: true });
          const previous = client.getQueryData<WorksSnapshot>(queryKey);
          if (!previous) return undefined;
          const next = optimistic(previous, variables);
          // Advance the acquisition watermark as well as the cache. An older
          // request can write directly from the snapshot adapter.
          seedWorksSnapshot(client, next, beginWorksSnapshotRequest(projectId));
          return { previous, optimistic: next };
        }
      : undefined,
    onError: optimistic
      ? (_error, _variables, context) => {
          const current = client.getQueryData<WorksSnapshot>(queryKey);
          if (!context || !current) return;
          seedWorksSnapshot(
            client,
            revertOptimistic(current, context),
            beginWorksSnapshotRequest(projectId),
          );
        }
      : undefined,
    onSuccess: confirmed
      ? (result) => {
          const current = client.getQueryData<WorksSnapshot>(queryKey);
          if (!current) return;
          const work = result as Work;
          seedWorksSnapshot(
            client,
            patchSnapshotWork(current, work.id, work),
            beginWorksSnapshotRequest(projectId),
          );
        }
      : undefined,
    onSettled: () => convergeWorkCommand(client, projectId, operation),
  });
  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}

const workCommandKey = (projectId: string) => ["work-command", projectId] as const;

function convergeWorkCommand(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
): Promise<void> {
  convergeWorkProjection(client, { kind: "entity", projectId, operation });
  // A server snapshot read now would erase the projections of Work commands
  // still pending (queued in the lifecycle scope); the last one to settle
  // repairs. This command still counts as pending while it settles, and a
  // confirmed command has already installed its own Work.
  if (client.isMutating({ mutationKey: workCommandKey(projectId) }) > 1) return Promise.resolve();
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
