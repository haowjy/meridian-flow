/**
 * Works reads and Work commands. The query cache holds only server snapshots;
 * readers see that snapshot with every pending Work command's expected result
 * laid over it, and a command's failure is read back from the mutation cache.
 */
import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import {
  type Mutation,
  type MutationStatus,
  type QueryClient,
  type UseMutateAsyncFunction,
  type UseMutateFunction,
  useMutation,
  useMutationState,
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
  installCommittedWork,
  refreshWorksSnapshot,
  repairWorksSnapshot,
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
  const pending = useWorkCommandRecords(projectId, "pending");
  const snapshot = useMemo(
    () => (list.data ? projectPendingCommands(list.data, pending) : undefined),
    [list.data, pending],
  );
  const works = useMemo(
    () => snapshot?.works.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null),
    [snapshot?.works, list.isError],
  );
  // Soft-deleted Works stay restorable until their purge date; newest first.
  const deleted = useMemo(
    () =>
      (snapshot?.works.filter((work) => work.deletedAt !== null) ?? []).sort((a, b) =>
        (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
      ),
    [snapshot?.works],
  );
  const noWork = snapshot?.noWork ?? null;
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
}

type WorkCommandVariables = {
  update: { workId: string; data: UpdateWorkRequest };
  archive: string;
  unarchive: string;
  delete: string;
  restore: string;
};

export type WorkOperation = keyof WorkCommandVariables;

export interface WorkMutations {
  update: WorkCommand<Work, WorkCommandVariables["update"]>;
  archive: WorkCommand<Work, string>;
  unarchive: WorkCommand<Work, string>;
  delete: WorkCommand<void, string>;
  restore: WorkCommand<Work, string>;
}

export function useWorkMutations(projectId: string): WorkMutations {
  const client = useQueryClient();
  // Lifecycle commands run one at a time on the network; each still shows at once.
  const lifecycle = { id: `work-lifecycle:${projectId}` };
  const update = useWorkCommand(client, projectId, "update", ({ workId, data }) =>
    updateWork(workId, data),
  );
  const archive = useWorkCommand(client, projectId, "archive", (id) => archiveWork(id), lifecycle);
  const unarchive = useWorkCommand(
    client,
    projectId,
    "unarchive",
    (id) => unarchiveWork(id),
    lifecycle,
  );
  const remove = useWorkCommand(client, projectId, "delete", (id) => deleteWork(id), lifecycle);
  const restore = useWorkCommand(client, projectId, "restore", (id) => restoreWork(id), lifecycle);
  return { update, archive, unarchive, delete: remove, restore };
}

const workCommandKey = (projectId: string, operation?: WorkOperation) =>
  operation
    ? (["work-command", projectId, operation] as const)
    : (["work-command", projectId] as const);

const commandWorkId = <Op extends WorkOperation>(
  operation: Op,
  variables: WorkCommandVariables[Op],
): string =>
  operation === "update"
    ? (variables as WorkCommandVariables["update"]).workId
    : (variables as string);

function useWorkCommand<Op extends WorkOperation, TResult>(
  client: QueryClient,
  projectId: string,
  operation: Op,
  command: (variables: WorkCommandVariables[Op]) => Promise<TResult>,
  scope?: { id: string },
): WorkCommand<TResult, WorkCommandVariables[Op]> {
  const mutation = useMutation<TResult, Error, WorkCommandVariables[Op]>({
    mutationKey: workCommandKey(projectId, operation),
    mutationFn: command,
    scope,
    // A failed command stays on its Work until the writer retries, dismisses,
    // or runs another command on that Work; settled records are pruned then.
    gcTime: Number.POSITIVE_INFINITY,
    onMutate: (variables) => {
      forgetSettledCommands(client, projectId, commandWorkId(operation, variables));
    },
    onSettled: (result, error) =>
      settleWorkCommand(client, projectId, operation, error ? null : (result as Work | undefined)),
  });
  return { mutate: mutation.mutate, mutateAsync: mutation.mutateAsync };
}

/**
 * Converges dependent caches, then keeps a successful command pending until a
 * server snapshot read started after its commit lands, so its projection never
 * drops before the snapshot includes it. Reads are ordered by
 * `authorityRevision`, so an older read cannot replace that newer one.
 */
async function settleWorkCommand(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  committed: Work | undefined | null,
): Promise<void> {
  convergeWorkProjection(client, { kind: "entity", projectId, operation });
  if (committed === null) {
    // The projection drops now; a read still catches a write the server kept.
    void repairWorksSnapshot(client, projectId);
    return;
  }
  try {
    await refreshWorksSnapshot(client, projectId);
  } catch {
    // Without a fresh snapshot, the Work the server returned is the best truth.
    if (committed) installCommittedWork(client, projectId, committed);
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
}

type WorkCommandRecord = {
  mutationId: number;
  operation: WorkOperation;
  workId: string;
  variables: unknown;
  submittedAt: number;
  status: MutationStatus;
  error: Error | null;
};

function workCommandRecord(mutation: Mutation<unknown, Error, unknown>): WorkCommandRecord | null {
  const operation = mutation.options.mutationKey?.[2] as WorkOperation | undefined;
  const { variables, status, submittedAt, error } = mutation.state;
  if (!operation || variables === undefined || status === "idle") return null;
  return {
    mutationId: mutation.mutationId,
    operation,
    workId: commandWorkId(operation, variables as WorkCommandVariables[WorkOperation]),
    variables,
    submittedAt,
    status,
    error,
  };
}

/** This project's Work commands, oldest first. */
function useWorkCommandRecords(projectId: string, status?: MutationStatus) {
  const records = useMutationState({
    filters: { mutationKey: workCommandKey(projectId), status },
    select: (mutation) => workCommandRecord(mutation as Mutation<unknown, Error, unknown>),
  });
  return useMemo(
    () =>
      records
        .filter((record): record is WorkCommandRecord => record !== null)
        .sort((a, b) => a.mutationId - b.mutationId),
    [records],
  );
}

/** What a pending command will make true of its Work. Delete is shown by its Undo row. */
function commandProjection(record: WorkCommandRecord): Partial<Work> | null {
  const at = new Date(record.submittedAt).toISOString();
  switch (record.operation) {
    case "update":
      return { ...(record.variables as WorkCommandVariables["update"]).data, updatedAt: at };
    case "archive":
      return { status: "archived", archivedAt: at };
    case "unarchive":
      return { status: "active", archivedAt: null };
    case "restore":
      return { deletedAt: null };
    case "delete":
      return null;
  }
}

function projectPendingCommands(
  snapshot: WorksSnapshot,
  pending: readonly WorkCommandRecord[],
): WorksSnapshot {
  const fields = new Map<string, Partial<Work>>();
  for (const record of pending) {
    const projection = commandProjection(record);
    if (projection) fields.set(record.workId, { ...fields.get(record.workId), ...projection });
  }
  if (!fields.size) return snapshot;
  const patch = <T extends Work>(work: T): T => {
    const next = fields.get(work.id);
    return next ? ({ ...work, ...next } as T) : work;
  };
  return { ...snapshot, works: snapshot.works.map(patch), noWork: patch(snapshot.noWork) };
}

function findWorkCommands(client: QueryClient, projectId: string) {
  return client.getMutationCache().findAll({ mutationKey: workCommandKey(projectId) });
}

function forgetSettledCommands(client: QueryClient, projectId: string, workId: string): void {
  const cache = client.getMutationCache();
  for (const mutation of findWorkCommands(client, projectId)) {
    if (mutation.state.status === "pending") continue;
    if (workCommandRecord(mutation as Mutation<unknown, Error, unknown>)?.workId === workId)
      cache.remove(mutation);
  }
}

export type WorkCommandFailure<Op extends WorkOperation = WorkOperation> = {
  workId: string;
  operation: Op;
  error: Error;
  dismiss: () => void;
};

/**
 * The failed command each Work still shows, keyed by Work id. A Work's latest
 * command wins, so a retry or any newer command on it replaces the failure.
 * Every surface reads the same mutation cache, so the list and the band agree.
 */
export function useWorkCommandFailures<Op extends WorkOperation>(
  projectId: string,
  operations: readonly Op[],
): ReadonlyMap<string, WorkCommandFailure<Op>> {
  const client = useQueryClient();
  const records = useWorkCommandRecords(projectId);
  const shown = operations.join(" ");
  return useMemo(() => {
    const latest = new Map<string, WorkCommandRecord>();
    for (const record of records) latest.set(record.workId, record);
    const failures = new Map<string, WorkCommandFailure<Op>>();
    for (const record of latest.values()) {
      if (record.status !== "error" || !record.error) continue;
      if (!shown.split(" ").includes(record.operation)) continue;
      failures.set(record.workId, {
        workId: record.workId,
        operation: record.operation as Op,
        error: record.error,
        dismiss: () => {
          const cache = client.getMutationCache();
          const mutation = cache.getAll().find((m) => m.mutationId === record.mutationId);
          if (mutation) cache.remove(mutation);
        },
      });
    }
    return failures;
  }, [client, records, shown]);
}

/** Works whose restore is still on its way; they already show in their tab. */
export function useRestoringWorkIds(projectId: string): ReadonlySet<string> {
  const pending = useWorkCommandRecords(projectId, "pending");
  return useMemo(
    () =>
      new Set(
        pending.filter((record) => record.operation === "restore").map((record) => record.workId),
      ),
    [pending],
  );
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
