/**
 * Works reads and Work commands. The query cache holds only server snapshots;
 * readers see that snapshot with every pending Work command's expected result
 * laid over it. A command's failure, and a delete's Undo window, are read back
 * from the mutation cache, so every surface shows the same ones.
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
  listProjectWorks,
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

function useWorksSnapshot(projectId: string, requested = true) {
  const enabled = requested && !useIsProjectPendingCreation(projectId);
  const client = useQueryClient();
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => acquireWorksSnapshot(client, projectId),
    staleTime: 30_000,
    enabled,
  });
  return { list, enabled };
}

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const { list, enabled } = useWorksSnapshot(projectId, options?.enabled);
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

/** Identifies one command's record in the mutation cache after it settles. */
type CommandReceipt = Record<string, never>;

function useWorkCommand<Op extends WorkOperation, TResult>(
  client: QueryClient,
  projectId: string,
  operation: Op,
  command: (variables: WorkCommandVariables[Op]) => Promise<TResult>,
  scope?: { id: string },
): WorkCommand<TResult, WorkCommandVariables[Op]> {
  const mutation = useMutation<TResult, Error, WorkCommandVariables[Op], CommandReceipt>({
    mutationKey: workCommandKey(projectId, operation),
    mutationFn: command,
    scope,
    // A failure or a delete's Undo window stays until the writer acts on it,
    // or runs another command on that Work; a success record goes on settle.
    gcTime: Number.POSITIVE_INFINITY,
    onMutate: (variables) => {
      forgetSettledCommands(client, projectId, operation, commandWorkId(operation, variables));
      return {};
    },
    onSettled: (result, error, variables, receipt) =>
      settleWorkCommand(client, projectId, operation, variables, receipt, {
        ok: !error,
        committed: result as Work | undefined,
      }),
  });
  return { mutate: mutation.mutate, mutateAsync: mutation.mutateAsync };
}

/** A stalled read must not hold the lifecycle queue; the fallback patch covers it. */
const COMMIT_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Converges dependent caches, then keeps a successful command pending until a
 * server snapshot read started after its commit lands, so its projection never
 * drops before the snapshot includes it. Reads are ordered by
 * `authorityRevision`, so an older read cannot replace that newer one.
 */
async function settleWorkCommand<Op extends WorkOperation>(
  client: QueryClient,
  projectId: string,
  operation: Op,
  variables: WorkCommandVariables[Op],
  receipt: CommandReceipt | undefined,
  outcome: { ok: boolean; committed: Work | undefined },
): Promise<void> {
  convergeWorkProjection(client, { kind: "entity", projectId, operation });
  if (!outcome.ok) {
    // The projection drops now; a read still catches a write the server kept.
    void repairWorksSnapshot(client, projectId);
    return;
  }
  try {
    await refreshWorksSnapshot(client, projectId, () =>
      listProjectWorks(projectId, { signal: AbortSignal.timeout(COMMIT_REFRESH_TIMEOUT_MS) }),
    );
  } catch {
    // Without a fresh snapshot, what the server returned is the best truth for
    // the fields this command owns; the rest stays as last read.
    installCommittedWork(
      client,
      projectId,
      commandWorkId(operation, variables),
      committedFields(operation, variables, outcome.committed),
    );
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
  if (receipt) retireOnSuccess(client, projectId, receipt);
}

/** The fields a committed command owns, as the server returned them. */
function committedFields<Op extends WorkOperation>(
  operation: Op,
  variables: WorkCommandVariables[Op],
  committed: Work | undefined,
): Partial<Work> {
  if (operation === "delete") return { deletedAt: new Date().toISOString() };
  if (!committed) return {};
  switch (operation) {
    case "update": {
      const { data } = variables as WorkCommandVariables["update"];
      const owned = Object.keys(data) as (keyof UpdateWorkRequest & keyof Work)[];
      return Object.fromEntries(owned.map((key) => [key, committed[key]])) as Partial<Work>;
    }
    case "archive":
    case "unarchive":
      return { status: committed.status, archivedAt: committed.archivedAt };
    case "restore":
      return { deletedAt: committed.deletedAt };
    default:
      return {};
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

/** What a pending command will make true of its Work. */
function commandProjection(record: WorkCommandRecord): Partial<Work> {
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
      return { deletedAt: at };
  }
}

/** Whether the server snapshot already shows what this command asked for. */
function snapshotHasCommandTarget(
  snapshot: WorksSnapshot | undefined,
  record: WorkCommandRecord,
): boolean {
  if (!snapshot) return false;
  const work = snapshotWork(snapshot, record.workId);
  switch (record.operation) {
    case "update": {
      const { data } = record.variables as WorkCommandVariables["update"];
      return (
        !!work && Object.entries(data).every(([key, value]) => work[key as keyof Work] === value)
      );
    }
    case "archive":
      return work?.status === "archived";
    case "unarchive":
      return work?.status === "active";
    case "restore":
      return !!work && work.deletedAt === null;
    case "delete":
      return !work || work.deletedAt !== null;
  }
}

function snapshotWork(snapshot: WorksSnapshot, workId: string): Work | undefined {
  if (snapshot.noWork.id === workId) return snapshot.noWork;
  return snapshot.works.find((work) => work.id === workId);
}

function projectPendingCommands(
  snapshot: WorksSnapshot,
  pending: readonly WorkCommandRecord[],
): WorksSnapshot {
  const fields = new Map<string, Partial<Work>>();
  for (const record of pending) {
    fields.set(record.workId, { ...fields.get(record.workId), ...commandProjection(record) });
  }
  if (!fields.size) return snapshot;
  const patch = <T extends Work>(work: T): T => {
    const next = fields.get(work.id);
    return next ? ({ ...work, ...next } as T) : work;
  };
  return { ...snapshot, works: snapshot.works.map(patch), noWork: patch(snapshot.noWork) };
}

function workCommandsOn(client: QueryClient, projectId: string, workId: string) {
  return client
    .getMutationCache()
    .findAll({ mutationKey: workCommandKey(projectId) })
    .filter(
      (mutation) =>
        workCommandRecord(mutation as Mutation<unknown, Error, unknown>)?.workId === workId,
    );
}

/**
 * A new command replaces what the Work showed before. An Undo (restore) keeps
 * the delete it answers, so a rejected Undo brings the Undo row back.
 */
function forgetSettledCommands(
  client: QueryClient,
  projectId: string,
  operation: WorkOperation,
  workId: string,
): void {
  const cache = client.getMutationCache();
  for (const mutation of workCommandsOn(client, projectId, workId)) {
    if (mutation.state.status === "pending") continue;
    const keepsDelete =
      operation === "restore" &&
      mutation.options.mutationKey?.[2] === "delete" &&
      mutation.state.status === "success";
    if (!keepsDelete) cache.remove(mutation);
  }
}

/**
 * Once a command's success lands in the mutation cache, it drops its record
 * and every older settled one on its Work. A delete keeps its own record: that
 * record is its Undo window.
 */
function retireOnSuccess(client: QueryClient, projectId: string, receipt: CommandReceipt): void {
  const cache = client.getMutationCache();
  const unsubscribe = cache.subscribe((event) => {
    const mutation = event.mutation as Mutation<unknown, Error, unknown> | undefined;
    if (!mutation || mutation.state.context !== receipt) return;
    if (mutation.state.status === "pending") return;
    unsubscribe();
    const record = workCommandRecord(mutation);
    if (mutation.state.status !== "success" || !record) return;
    for (const other of workCommandsOn(client, projectId, record.workId)) {
      if (other.mutationId < record.mutationId && other.state.status !== "pending")
        cache.remove(other);
    }
    if (record.operation !== "delete") cache.remove(mutation);
  });
}

function removeWorkCommand(client: QueryClient, mutationId: number): void {
  const cache = client.getMutationCache();
  const mutation = cache.getAll().find((m) => m.mutationId === mutationId);
  if (mutation) cache.remove(mutation);
}

export type WorkCommandFailure<Op extends WorkOperation = WorkOperation> = {
  workId: string;
  operation: Op;
  error: Error;
  dismiss: () => void;
};

/**
 * The failed command each Work still shows, keyed by Work id. A Work's latest
 * command wins, so a retry or any newer command on it replaces the failure,
 * and a failure goes quiet once the server already shows its target (another
 * device archived the Work, say). Every surface reads the same mutation
 * cache, so the list and the band agree.
 */
export function useWorkCommandFailures<Op extends WorkOperation>(
  projectId: string,
  operations: readonly Op[],
): ReadonlyMap<string, WorkCommandFailure<Op>> {
  const client = useQueryClient();
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  const shown = operations.join(" ");
  return useMemo(() => {
    const latest = new Map<string, WorkCommandRecord>();
    for (const record of records) latest.set(record.workId, record);
    const failures = new Map<string, WorkCommandFailure<Op>>();
    for (const record of latest.values()) {
      if (record.status !== "error" || !record.error) continue;
      if (!shown.split(" ").includes(record.operation)) continue;
      if (snapshotHasCommandTarget(server, record)) continue;
      failures.set(record.workId, {
        workId: record.workId,
        operation: record.operation as Op,
        error: record.error,
        dismiss: () => removeWorkCommand(client, record.mutationId),
      });
    }
    return failures;
  }, [client, records, server, shown]);
}

/**
 * A deleted Work's Undo window: open from the delete until the writer undoes
 * or dismisses it. A rejected Undo reopens it with that error.
 */
export type WorkDeleteWindow = {
  workId: string;
  /** The delete's record; closing the window removes it once settled. */
  mutationId: number;
  /** The delete is still on its way to the server. */
  pending: boolean;
  undoError: Error | null;
};

/** Every open Undo window in this project, oldest delete first. */
export function useWorkDeleteWindows(projectId: string): readonly WorkDeleteWindow[] {
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  return useMemo(() => {
    // Each Work's latest delete, and what the writer did after it.
    const latest = new Map<string, { remove: WorkCommandRecord; after: WorkCommandRecord[] }>();
    for (const record of records) {
      if (record.operation === "delete") latest.set(record.workId, { remove: record, after: [] });
      else latest.get(record.workId)?.after.push(record);
    }
    const windows: WorkDeleteWindow[] = [];
    for (const [workId, { remove, after }] of latest) {
      if (remove.status === "error") continue;
      // An Undo on its way shows as the Work restoring in its tab.
      if (after.some((record) => record.status !== "error")) continue;
      // Restored elsewhere: the Work is back, so there is nothing to undo.
      if (remove.status === "success" && server && !snapshotHasCommandTarget(server, remove))
        continue;
      const undo = after.filter((record) => record.operation === "restore").at(-1);
      windows.push({
        workId,
        mutationId: remove.mutationId,
        pending: remove.status === "pending",
        undoError: undo?.error ?? null,
      });
    }
    return windows;
  }, [records, server]);
}

/** Closes a settled Undo window: its delete record and any rejected Undo go. */
export function useCloseWorkDeleteWindow(projectId: string) {
  const client = useQueryClient();
  return useCallback(
    (workId: string) => {
      const cache = client.getMutationCache();
      for (const mutation of workCommandsOn(client, projectId, workId)) {
        const operation = mutation.options.mutationKey?.[2];
        if (mutation.state.status === "pending") continue;
        if (operation === "delete" || operation === "restore") cache.remove(mutation);
      }
    },
    [client, projectId],
  );
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
