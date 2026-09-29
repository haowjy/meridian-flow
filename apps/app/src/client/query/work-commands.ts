/**
 * Work commands and their records. One table says, per operation, what it
 * sends, what it shows while pending, which fields it owns once committed,
 * and when the server already shows it; `useWorkMutations` is generated from
 * it. Each command leaves a record in a per-project store: pending until the
 * server snapshot includes it, then gone, except a failure, which stays until
 * the writer retries or dismisses it, and a delete, whose record is its Undo
 * window. Records live in the QueryClient, scoped to the signed-in account.
 */
import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  archiveWork,
  deleteWork,
  listProjectWorks,
  restoreWork,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
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
  id: number;
  workId: string;
  submittedAt: number;
  /** `done` is a delete that landed: its Undo window. */
  status: "pending" | "failed" | "done";
  /** The writer closed it: a pending delete's Undo window. */
  dismissed: boolean;
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
  const accountSignal = useOptionalAccountEpochSignal();
  return useMemo(
    () =>
      Object.fromEntries(
        OPERATIONS.map((operation) => [
          operation,
          (variables: WorkCommandVariables[WorkOperation]) =>
            runWorkCommand(
              client,
              projectId,
              { operation, variables } as WorkCommand,
              accountSignal,
            ),
        ]),
      ) as WorkMutations,
    [accountSignal, client, projectId],
  );
}

// --- The record store -------------------------------------------------------

const NO_RECORDS: readonly WorkCommandRecord[] = [];

function readRecords(client: QueryClient, projectId: string): readonly WorkCommandRecord[] {
  return (
    client.getQueryData<readonly WorkCommandRecord[]>(projectQueryKeys.workCommands(projectId)) ??
    NO_RECORDS
  );
}

function writeRecords(
  client: QueryClient,
  projectId: string,
  update: (records: readonly WorkCommandRecord[]) => readonly WorkCommandRecord[],
): void {
  client.setQueryData(
    projectQueryKeys.workCommands(projectId),
    update(readRecords(client, projectId)),
  );
}

/** This project's Work command records, oldest first. */
export function useWorkCommandRecords(projectId: string): readonly WorkCommandRecord[] {
  const client = useQueryClient();
  return useQuery({
    queryKey: projectQueryKeys.workCommands(projectId),
    queryFn: () => readRecords(client, projectId),
    initialData: () => readRecords(client, projectId),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

/** Per project, the serial commands' network queue. */
const queues = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();
const accountsSeen = new WeakMap<QueryClient, WeakSet<AbortSignal>>();
let lastRecordId = 0;

function projectQueues(client: QueryClient): Map<string, Promise<unknown>> {
  let byProject = queues.get(client);
  if (!byProject) {
    byProject = new Map();
    queues.set(client, byProject);
  }
  return byProject;
}

/** Account replacement drops every record; a command still running then writes nothing. */
function scopeToAccount(client: QueryClient, accountSignal: AbortSignal | null): void {
  if (!accountSignal) return;
  let seen = accountsSeen.get(client);
  if (!seen) {
    seen = new WeakSet();
    accountsSeen.set(client, seen);
  }
  if (seen.has(accountSignal)) return;
  seen.add(accountSignal);
  accountSignal.addEventListener(
    "abort",
    () => {
      const stores = client.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey[0] === "projects" && query.queryKey[2] === "work-commands",
      });
      for (const store of stores) client.setQueryData(store.queryKey, NO_RECORDS);
    },
    { once: true },
  );
}

function runWorkCommand(
  client: QueryClient,
  projectId: string,
  command: WorkCommand,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  scopeToAccount(client, accountSignal);
  const record = {
    ...command,
    id: ++lastRecordId,
    workId: command.variables.workId,
    submittedAt: Date.now(),
    status: "pending",
    dismissed: false,
    error: null,
  } as WorkCommandRecord;
  // A new command replaces what its Work showed before. An Undo (restore)
  // keeps the delete it answers, so a rejected Undo brings the Undo row back.
  writeRecords(client, projectId, (records) => [
    ...records.filter(
      (other) =>
        other.workId !== record.workId ||
        other.status === "pending" ||
        (record.operation === "restore" && other.operation === "delete" && other.status === "done"),
    ),
    record,
  ]);
  const run = () => executeWorkCommand(client, projectId, record, accountSignal);
  if (!specs[command.operation].serial) return run();
  const serial = projectQueues(client);
  const outcome = (serial.get(projectId) ?? Promise.resolve()).then(run);
  serial.set(projectId, outcome);
  return outcome;
}

/** A stalled read must not hold the serial queue; the fallback patch covers it. */
const COMMIT_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Sends the command, then keeps its record pending until a server snapshot
 * read started after the commit lands, so its projection never drops before
 * the snapshot includes it. Reads are ordered by `authorityRevision`, so an
 * older read cannot replace that newer one.
 */
async function executeWorkCommand(
  client: QueryClient,
  projectId: string,
  record: WorkCommandRecord,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  const current = () => !accountSignal?.aborted;
  let committed: unknown;
  try {
    committed = await request(record);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!current()) return error;
    convergeWorkProjection(client, { kind: "entity", projectId, operation: record.operation });
    updateRecord(client, projectId, record.id, (failed) => ({
      ...failed,
      status: "failed",
      dismissed: false,
      error,
    }));
    // The projection drops now; a read still catches a write the server kept.
    void repairWorksSnapshot(client, projectId);
    return error;
  }
  if (!current()) return null;
  convergeWorkProjection(client, { kind: "entity", projectId, operation: record.operation });
  try {
    await refreshWorksSnapshot(client, projectId, () =>
      listProjectWorks(projectId, { signal: AbortSignal.timeout(COMMIT_REFRESH_TIMEOUT_MS) }),
    );
  } catch {
    // Without a fresh snapshot, what the server returned is the best truth for
    // the fields this command owns; the rest stays as last read.
    installCommittedWork(client, projectId, record.workId, ownedFields(record, committed));
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
  if (current()) retire(client, projectId, record);
  return null;
}

function request<Op extends WorkOperation>(command: CommandOf<Op>): Promise<unknown> {
  return specs[command.operation].request(command.variables);
}

function ownedFields<Op extends WorkOperation>(
  command: CommandOf<Op>,
  committed: unknown,
): Partial<Work> {
  return specs[command.operation].owned(command.variables, committed as WorkCommandResults[Op]);
}

/**
 * A landed command drops its record and every older settled one on its Work.
 * A delete keeps its own, as its Undo window, unless the writer closed it.
 */
function retire(client: QueryClient, projectId: string, landed: WorkCommandRecord): void {
  writeRecords(client, projectId, (records) =>
    records.flatMap((record) => {
      if (record.id === landed.id)
        return record.operation === "delete" && !record.dismissed
          ? [{ ...record, status: "done" as const }]
          : [];
      const older = record.workId === landed.workId && record.id < landed.id;
      return older && record.status !== "pending" ? [] : [record];
    }),
  );
}

function updateRecord(
  client: QueryClient,
  projectId: string,
  id: number,
  update: (record: WorkCommandRecord) => WorkCommandRecord,
): void {
  writeRecords(client, projectId, (records) =>
    records.map((record) => (record.id === id ? update(record) : record)),
  );
}

/** Runs a failed command again, as a new command on its Work. */
export function retryWorkCommand(
  client: QueryClient,
  projectId: string,
  failed: WorkCommandRecord,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  const { operation, variables } = failed;
  return runWorkCommand(client, projectId, { operation, variables } as WorkCommand, accountSignal);
}

/** The writer dismissed a failure. */
export function dismissWorkCommand(client: QueryClient, projectId: string, id: number): void {
  writeRecords(client, projectId, (records) => records.filter((record) => record.id !== id));
}

/**
 * The writer closed a Work's Undo window: a landed delete and any rejected
 * Undo go; a delete still on its way is marked, and goes once it lands.
 */
export function closeWorkDeleteWindow(
  client: QueryClient,
  projectId: string,
  workId: string,
): void {
  writeRecords(client, projectId, (records) =>
    records.flatMap((record) => {
      if (record.workId !== workId) return [record];
      if (record.operation === "delete" && record.status === "pending")
        return [{ ...record, dismissed: true }];
      if (record.operation === "delete" && record.status === "done") return [];
      if (record.operation === "restore" && record.status === "failed") return [];
      return [record];
    }),
  );
}

// --- Reading a record against the snapshot ----------------------------------

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
