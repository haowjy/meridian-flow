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
  createProjectWork,
  deleteWork,
  listProjectWorks,
  restoreWork,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { createWithRecovery } from "@/client/creation/creation-registry";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  installCommittedWork,
  refreshWorksSnapshot,
  repairWorksSnapshot,
} from "./works-projection-acquisition";

export type WorkCommandVariables = {
  create: { workId: string; name: string; goal?: string };
  update: { workId: string; data: UpdateWorkRequest };
  archive: { workId: string };
  unarchive: { workId: string };
  delete: { workId: string };
  restore: { workId: string };
};

export type WorkOperation = keyof WorkCommandVariables;

type WorkCommandResults = {
  create: Work;
  update: Work;
  archive: Work;
  unarchive: Work;
  delete: unknown;
  restore: Work;
};

type CommandContext = { projectId: string; signal: AbortSignal | undefined };

type WorkCommandSpec<Op extends WorkOperation> = {
  request: (
    variables: WorkCommandVariables[Op],
    context: CommandContext,
  ) => Promise<WorkCommandResults[Op]>;
  /** The Work as this command expects to leave it, before the server answers. */
  project: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    context: { projectId: string; at: string },
  ) => Work | undefined;
  /** The Work with the committed fields this command owns, as the server returned them. */
  commit: (
    work: Work | undefined,
    variables: WorkCommandVariables[Op],
    committed: WorkCommandResults[Op],
  ) => Work | undefined;
  /** Whether the server snapshot already shows what this command asked for. */
  reached: (work: Work | undefined, variables: WorkCommandVariables[Op]) => boolean;
  /** Runs one at a time on the network with the project's other serial commands. */
  serial: boolean;
};

const patch = (work: Work | undefined, fields: Partial<Work>): Work | undefined =>
  work && { ...work, ...fields };

const workCommands = {
  create: {
    // A lost POST response is recovered by the Work's own id.
    request: ({ workId, name, goal }, { projectId, signal }) =>
      createWithRecovery(
        () => createProjectWork(projectId, { id: workId, name, goal }, { signal }),
        async () =>
          (await listProjectWorks(projectId, { signal })).works.find(
            (work) => work.id === workId,
          ) ?? null,
      ),
    project: (work, variables, { projectId, at }) => work ?? draftWork(projectId, variables, at),
    // A new Work has nothing unpushed yet.
    commit: (work, _, committed) =>
      work ?? { ...committed, unpushedChangeCount: committed.unpushedChangeCount ?? 0 },
    reached: (work) => !!work,
    serial: false,
  },
  update: {
    request: ({ workId, data }) => updateWork(workId, data),
    project: (work, { data }, { at }) => patch(work, { ...data, updatedAt: at }),
    commit: (work, { data }, committed) =>
      patch(
        work,
        Object.fromEntries(Object.keys(data).map((key) => [key, committed[key as keyof Work]])),
      ),
    reached: (work, { data }) =>
      !!work && Object.entries(data).every(([key, value]) => work[key as keyof Work] === value),
    serial: false,
  },
  archive: {
    request: ({ workId }) => archiveWork(workId),
    project: (work, _, { at }) => patch(work, { status: "archived", archivedAt: at }),
    commit: (work, _, { status, archivedAt }) => patch(work, { status, archivedAt }),
    reached: (work) => work?.status === "archived",
    serial: true,
  },
  unarchive: {
    request: ({ workId }) => unarchiveWork(workId),
    project: (work) => patch(work, { status: "active", archivedAt: null }),
    commit: (work, _, { status, archivedAt }) => patch(work, { status, archivedAt }),
    reached: (work) => work?.status === "active",
    serial: true,
  },
  delete: {
    request: ({ workId }) => deleteWork(workId),
    project: (work, _, { at }) => patch(work, { deletedAt: at }),
    // The server returns nothing: the client clock stands in for the delete
    // time, so the purge countdown is approximate until the next read.
    commit: (work) => patch(work, { deletedAt: work?.deletedAt ?? new Date().toISOString() }),
    reached: (work) => !work || work.deletedAt !== null,
    serial: true,
  },
  restore: {
    request: ({ workId }) => restoreWork(workId),
    project: (work) => patch(work, { deletedAt: null }),
    commit: (work, _, { deletedAt }) => patch(work, { deletedAt }),
    reached: (work) => !!work && work.deletedAt === null,
    serial: true,
  },
} satisfies { [Op in WorkOperation]: WorkCommandSpec<Op> };

/**
 * A Work the server has not created yet, as the writer asked for it. It shows
 * only as a Work being created (`WorkCreation`); fields the server assigns
 * stay empty.
 */
function draftWork(
  projectId: string,
  { workId, name, goal }: WorkCommandVariables["create"],
  at: string,
): Work {
  return {
    id: workId,
    projectId,
    createdByUserId: "",
    name,
    slug: null,
    isNoWork: false,
    goal: goal ?? null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: "0",
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    deletedAt: null,
  } as Work;
}

/** Indexed through the mapped type so a generic operation keeps its own spec. */
const specs: { [Op in WorkOperation]: WorkCommandSpec<Op> } = workCommands;

type CommandOf<Op extends WorkOperation> = { operation: Op; variables: WorkCommandVariables[Op] };

/** One Work command with its own variables. */
export type WorkCommand = { [Op in WorkOperation]: CommandOf<Op> }[WorkOperation];

type RecordOf<Op extends WorkOperation> = CommandOf<Op> & {
  /** What the server returned; set once the command committed. */
  committed?: { result: WorkCommandResults[Op] };
};

export type WorkCommandRecord = { [Op in WorkOperation]: RecordOf<Op> }[WorkOperation] & {
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
  let result: unknown;
  try {
    result = await request(record, { projectId, signal: accountSignal ?? undefined });
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
  const committed = { ...record, committed: { result } } as WorkCommandRecord;
  updateRecord(
    client,
    projectId,
    record.id,
    (sent) => ({ ...sent, committed: { result } }) as WorkCommandRecord,
  );
  convergeWorkProjection(client, { kind: "entity", projectId, operation: record.operation });
  try {
    await refreshWorksSnapshot(client, projectId, () =>
      listProjectWorks(projectId, { signal: AbortSignal.timeout(COMMIT_REFRESH_TIMEOUT_MS) }),
    );
  } catch {
    // Without a fresh snapshot, what the server returned is the best truth for
    // the fields this command owns; the rest stays as last read.
    installCommittedWork(client, projectId, record.workId, (work) =>
      recordProjection(work, committed, projectId),
    );
    await client.invalidateQueries({
      queryKey: projectQueryKeys.works(projectId),
      exact: true,
      refetchType: "none",
    });
  }
  if (current()) retire(client, projectId, record);
  return null;
}

function request<Op extends WorkOperation>(
  command: CommandOf<Op>,
  context: CommandContext,
): Promise<unknown> {
  return specs[command.operation].request(command.variables, context);
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

/**
 * A Work the server has not created yet: pending while its create is on its
 * way, failed once it was refused.
 */
export type WorkCreation = { work: Work; phase: "pending" | "failed" };

/**
 * The server snapshot with every pending command laid over it, oldest first:
 * what it expects before the server answers, what the server returned after.
 * A create shows as a `WorkCreation` until the server has the Work, then
 * first in the list, where the server's newest-first order will put it. A
 * Work being created shows even before the first snapshot loads.
 */
export function projectWorkCommands(
  projectId: string,
  snapshot: WorksSnapshot | undefined,
  records: readonly WorkCommandRecord[],
): { snapshot: WorksSnapshot | undefined; creations: ReadonlyMap<string, WorkCreation> } {
  const byId = new Map<string, Work>();
  if (snapshot) for (const work of [...snapshot.works, snapshot.noWork]) byId.set(work.id, work);
  const creations = new Map<string, WorkCreation>();
  const created: string[] = [];
  let changed = false;
  for (const record of records) {
    const refused = record.status === "failed" && record.operation === "create";
    if (record.status !== "pending" && !refused) continue;
    changed = true;
    const before = byId.get(record.workId);
    const after = recordProjection(before, record, projectId);
    if (!after) continue;
    byId.set(record.workId, after);
    if (before) continue;
    if (record.operation === "create" && !record.committed)
      creations.set(record.workId, { work: after, phase: refused ? "failed" : "pending" });
    else created.unshift(record.workId);
  }
  if (!changed || !snapshot) return { snapshot, creations };
  // Commands keep the catalog fields a snapshot entry carries.
  const pick = (id: string) => byId.get(id) as WorksSnapshot["works"][number];
  return {
    snapshot: {
      ...snapshot,
      works: [...created.map(pick), ...snapshot.works.map((work) => pick(work.id))],
      noWork: byId.get(snapshot.noWork.id) as WorksSnapshot["noWork"],
    },
    creations,
  };
}

function recordProjection<Op extends WorkOperation>(
  work: Work | undefined,
  record: RecordOf<Op> & { submittedAt: number },
  projectId: string,
): Work | undefined {
  const spec = specs[record.operation];
  if (record.committed) return spec.commit(work, record.variables, record.committed.result);
  const at = new Date(record.submittedAt).toISOString();
  return spec.project(work, record.variables, { projectId, at });
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
