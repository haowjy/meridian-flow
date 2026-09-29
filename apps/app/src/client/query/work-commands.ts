/**
 * Work commands: one table says, per operation, what it sends, what it shows
 * while pending, which fields it owns once committed, and when the server
 * already shows it. `useWorkMutations` is generated from that table, and each
 * command's record lives in the mutation cache until the server snapshot
 * includes it.
 */
import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import {
  type Mutation,
  type MutationStatus,
  type QueryClient,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import {
  archiveWork,
  deleteWork,
  listProjectWorks,
  restoreWork,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  installCommittedWork,
  refreshWorksSnapshot,
  repairWorksSnapshot,
} from "./works-projection-acquisition";

export type WorkCommandVariables = {
  update: { workId: string; data: UpdateWorkRequest };
  archive: { workId: string };
  unarchive: { workId: string };
  delete: { workId: string };
  restore: { workId: string };
};

export type WorkOperation = keyof WorkCommandVariables;

type WorkCommandResults = {
  update: Work;
  archive: Work;
  unarchive: Work;
  delete: unknown;
  restore: Work;
};

type WorkCommandSpec<Op extends WorkOperation> = {
  request: (variables: WorkCommandVariables[Op]) => Promise<WorkCommandResults[Op]>;
  /** What the pending command makes true of its Work, submitted at `at`. */
  project: (variables: WorkCommandVariables[Op], at: string) => Partial<Work>;
  /** The committed fields this command owns, patched in when the read after it fails. */
  owned: (variables: WorkCommandVariables[Op], committed: WorkCommandResults[Op]) => Partial<Work>;
  /** Whether the server already shows what this command asked for. */
  reached: (work: Work | undefined, variables: WorkCommandVariables[Op]) => boolean;
  /** Runs one at a time on the network with the project's other serial commands. */
  serial: boolean;
};

const workCommands = {
  update: {
    request: ({ workId, data }) => updateWork(workId, data),
    project: ({ data }, at) => ({ ...data, updatedAt: at }),
    owned: ({ data }, committed) =>
      Object.fromEntries(Object.keys(data).map((key) => [key, committed[key as keyof Work]])),
    reached: (work, { data }) =>
      !!work && Object.entries(data).every(([key, value]) => work[key as keyof Work] === value),
    serial: false,
  },
  archive: {
    request: ({ workId }) => archiveWork(workId),
    project: (_, at) => ({ status: "archived", archivedAt: at }),
    owned: (_, committed) => ({ status: committed.status, archivedAt: committed.archivedAt }),
    reached: (work) => work?.status === "archived",
    serial: true,
  },
  unarchive: {
    request: ({ workId }) => unarchiveWork(workId),
    project: () => ({ status: "active", archivedAt: null }),
    owned: (_, committed) => ({ status: committed.status, archivedAt: committed.archivedAt }),
    reached: (work) => work?.status === "active",
    serial: true,
  },
  delete: {
    request: ({ workId }) => deleteWork(workId),
    project: (_, at) => ({ deletedAt: at }),
    // The server returns nothing: the client clock stands in for the delete
    // time, so the purge countdown is approximate until the next read.
    owned: () => ({ deletedAt: new Date().toISOString() }),
    reached: (work) => !work || work.deletedAt !== null,
    serial: true,
  },
  restore: {
    request: ({ workId }) => restoreWork(workId),
    project: () => ({ deletedAt: null }),
    owned: (_, committed) => ({ deletedAt: committed.deletedAt }),
    reached: (work) => !!work && work.deletedAt === null,
    serial: true,
  },
} satisfies { [Op in WorkOperation]: WorkCommandSpec<Op> };

/** Indexed through the mapped type so a generic operation keeps its own spec. */
const specs: { [Op in WorkOperation]: WorkCommandSpec<Op> } = workCommands;

type CommandOf<Op extends WorkOperation> = { operation: Op; variables: WorkCommandVariables[Op] };

/** One Work command with its own variables. */
export type WorkCommand = { [Op in WorkOperation]: CommandOf<Op> }[WorkOperation];

export type WorkCommandRecord = WorkCommand & {
  mutationId: number;
  workId: string;
  submittedAt: number;
  status: MutationStatus;
  error: Error | null;
};

/** A command resolves to its failure, or `null` once the server has it. */
export type RunWorkCommand<Op extends WorkOperation> = (
  variables: WorkCommandVariables[Op],
) => Promise<Error | null>;

export type WorkMutations = { [Op in WorkOperation]: RunWorkCommand<Op> };

const OPERATIONS = Object.keys(workCommands) as WorkOperation[];

export function useWorkMutations(projectId: string): WorkMutations {
  const client = useQueryClient();
  return useMemo(
    () =>
      Object.fromEntries(
        OPERATIONS.map((operation) => [
          operation,
          (variables: WorkCommandVariables[WorkOperation]) =>
            runWorkCommand(client, projectId, { operation, variables } as WorkCommand),
        ]),
      ) as WorkMutations,
    [client, projectId],
  );
}

const workCommandKey = (projectId: string, operation?: WorkOperation) =>
  operation
    ? (["work-command", projectId, operation] as const)
    : (["work-command", projectId] as const);

/** Identifies one command's record in the mutation cache after it settles. */
type CommandReceipt = Record<string, never>;

function runWorkCommand(
  client: QueryClient,
  projectId: string,
  command: WorkCommand,
): Promise<Error | null> {
  const { operation, variables } = command;
  const mutation = client
    .getMutationCache()
    .build<unknown, Error, unknown, CommandReceipt>(client, {
      mutationKey: workCommandKey(projectId, operation),
      mutationFn: () => specs[operation].request(variables as never),
      scope: specs[operation].serial ? { id: `work-lifecycle:${projectId}` } : undefined,
      // A failure or a delete's Undo window stays until the writer acts on it,
      // or runs another command on that Work; a success record goes on settle.
      gcTime: Number.POSITIVE_INFINITY,
      onMutate: () => {
        forgetSettledCommands(client, projectId, operation, variables.workId);
        return {};
      },
      onSettled: (result, error, _variables, receipt) =>
        settleWorkCommand(client, projectId, command, receipt, error ? undefined : { result }),
    });
  return mutation.execute(variables).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

/** A stalled read must not hold the lifecycle queue; the fallback patch covers it. */
const COMMIT_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Converges dependent caches, then keeps a successful command pending until a
 * server snapshot read started after its commit lands, so its projection never
 * drops before the snapshot includes it. Reads are ordered by
 * `authorityRevision`, so an older read cannot replace that newer one.
 */
async function settleWorkCommand(
  client: QueryClient,
  projectId: string,
  command: WorkCommand,
  receipt: CommandReceipt | undefined,
  committed: { result: unknown } | undefined,
): Promise<void> {
  convergeWorkProjection(client, { kind: "entity", projectId, operation: command.operation });
  if (!committed) {
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
      command.variables.workId,
      ownedFields(command, committed.result),
    );
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
  if (receipt) retireOnSuccess(client, projectId, receipt);
}

function ownedFields<Op extends WorkOperation>(
  command: CommandOf<Op>,
  committed: unknown,
): Partial<Work> {
  return specs[command.operation].owned(command.variables, committed as WorkCommandResults[Op]);
}

/** What a pending command will make true of its Work. */
export function commandProjection<Op extends WorkOperation>(
  record: CommandOf<Op> & { submittedAt: number },
): Partial<Work> {
  return specs[record.operation].project(
    record.variables,
    new Date(record.submittedAt).toISOString(),
  );
}

/** Whether the server snapshot already shows what this command asked for. */
export function snapshotHasCommandTarget<Op extends WorkOperation>(
  snapshot: WorksSnapshot | undefined,
  command: CommandOf<Op>,
): boolean {
  if (!snapshot) return false;
  const { workId } = command.variables;
  const work =
    snapshot.noWork.id === workId
      ? snapshot.noWork
      : snapshot.works.find((entry) => entry.id === workId);
  return specs[command.operation].reached(work, command.variables);
}

function workCommandRecord(mutation: Mutation<unknown, Error, unknown>): WorkCommandRecord | null {
  const operation = mutation.options.mutationKey?.[2] as WorkOperation | undefined;
  const { variables, status, submittedAt, error } = mutation.state;
  if (!operation || variables === undefined || status === "idle") return null;
  return {
    operation,
    variables: variables as WorkCommandVariables[WorkOperation],
    workId: (variables as { workId: string }).workId,
    mutationId: mutation.mutationId,
    submittedAt,
    status,
    error,
  } as WorkCommandRecord;
}

/** This project's Work commands, oldest first. */
export function useWorkCommandRecords(projectId: string, status?: MutationStatus) {
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

export function workCommandsOn(client: QueryClient, projectId: string, workId: string) {
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

export function removeWorkCommand(client: QueryClient, mutationId: number): void {
  const cache = client.getMutationCache();
  const mutation = cache.getAll().find((m) => m.mutationId === mutationId);
  if (mutation) cache.remove(mutation);
}
