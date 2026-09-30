/**
 * The per-project Work command record store. Each command leaves a record:
 * pending until the server snapshot includes it, then gone, except a failure
 * a surface shows, which stays until the writer retries or dismisses it, and
 * a delete, whose record is its Undo window. Records live in the QueryClient,
 * scoped to the signed-in account: an account switch drops them and stops
 * every command that has not reached the network.
 */
import type { WorksSnapshot } from "@meridian/contracts/works";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { listProjectWorks } from "@/client/api/projects-api";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";
import { recordProjection, snapshotHasCommandTarget } from "./work-command-projection";
import {
  type CommandOf,
  type RecordOf,
  type WorkCommandRecord,
  type WorkCommandVariables,
  type WorkMutations,
  type WorkOperation,
  workCommandSpecs,
} from "./work-commands";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  installCommittedWork,
  refreshWorksSnapshot,
  repairWorksSnapshot,
} from "./works-projection-acquisition";

export function useWorkMutations(projectId: string): WorkMutations {
  const client = useQueryClient();
  const accountSignal = useOptionalAccountEpochSignal();
  return useMemo(() => {
    const command =
      <Op extends WorkOperation>(operation: Op) =>
      (variables: WorkCommandVariables[Op]) =>
        runWorkCommand(client, projectId, { operation, variables }, accountSignal);
    return {
      create: command("create"),
      update: command("update"),
      archive: command("archive"),
      unarchive: command("unarchive"),
      delete: command("delete"),
      restore: command("restore"),
    };
  }, [accountSignal, client, projectId]);
}

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

/** Replaces one record; an id names one operation, so its type carries over. */
function updateRecord<Op extends WorkOperation>(
  client: QueryClient,
  projectId: string,
  id: number,
  update: (record: RecordOf<Op>) => RecordOf<Op>,
): void {
  writeRecords(client, projectId, (records) =>
    records.map((record) =>
      record.id === id ? (update(record as RecordOf<Op>) as WorkCommandRecord) : record,
    ),
  );
}

function removeRecord(client: QueryClient, projectId: string, id: number): void {
  writeRecords(client, projectId, (records) => records.filter((record) => record.id !== id));
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

/** Per project, the serial commands' network queue; an idle project has none. */
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

const [RECORDS_ROOT, , RECORDS_NAME] = projectQueryKeys.workCommands("");

/** Account replacement drops every project's records. */
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
        predicate: ({ queryKey }) => queryKey[0] === RECORDS_ROOT && queryKey[2] === RECORDS_NAME,
      });
      for (const store of stores) client.setQueryData(store.queryKey, NO_RECORDS);
    },
    { once: true },
  );
}

const aborted = () => new DOMException("Aborted", "AbortError");

function runWorkCommand<Op extends WorkOperation>(
  client: QueryClient,
  projectId: string,
  command: CommandOf<Op>,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  if (accountSignal?.aborted) return Promise.resolve(aborted());
  scopeToAccount(client, accountSignal);
  const record: RecordOf<Op> = {
    ...command,
    id: ++lastRecordId,
    workId: command.variables.workId,
    submittedAt: Date.now(),
    status: "pending",
    dismissed: false,
    error: null,
  };
  // A new command replaces what its Work showed before. An Undo (restore)
  // keeps the delete it answers, so a rejected Undo brings the Undo row back.
  writeRecords(client, projectId, (records) => [
    ...records.filter(
      (other) =>
        other.workId !== record.workId ||
        other.status === "pending" ||
        (record.operation === "restore" && other.operation === "delete" && other.status === "done"),
    ),
    record as WorkCommandRecord,
  ]);
  const run = () => executeWorkCommand(client, projectId, record, accountSignal);
  if (!workCommandSpecs[command.operation].serial) return run();
  const serial = projectQueues(client);
  const outcome = (serial.get(projectId) ?? Promise.resolve()).then(run);
  serial.set(projectId, outcome);
  void outcome.then(() => {
    if (serial.get(projectId) === outcome) serial.delete(projectId);
  });
  return outcome;
}

/** A stalled read must not hold the serial queue; the fallback patch covers it. */
const COMMIT_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Sends the command, then keeps its record pending until a server snapshot
 * read started after the commit lands, so its projection never drops before
 * the snapshot includes it. Reads are ordered by `authorityRevision`, so an
 * older read cannot replace that newer one. A command the account left while
 * it waited in the queue is never sent.
 */
async function executeWorkCommand<Op extends WorkOperation>(
  client: QueryClient,
  projectId: string,
  record: RecordOf<Op>,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  const current = () => !accountSignal?.aborted;
  if (!current()) return aborted();
  const spec = workCommandSpecs[record.operation];
  let result: Awaited<ReturnType<typeof spec.request>>;
  try {
    result = await spec.request(record.variables, {
      projectId,
      signal: accountSignal ?? undefined,
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!current()) return error;
    convergeWorkProjection(client, { kind: "entity", projectId, operation: record.operation });
    if (spec.keepsFailure)
      updateRecord<Op>(client, projectId, record.id, (failed) => ({
        ...failed,
        status: "failed",
        dismissed: false,
        error,
      }));
    else removeRecord(client, projectId, record.id);
    // The projection drops now; a read still catches a write the server kept,
    // and then there is no failure left to show.
    void repairWorksSnapshot(client, projectId).then(() => {
      if (current() && snapshotHasCommandTarget(readSnapshot(client, projectId), record))
        removeRecord(client, projectId, record.id);
    });
    return error;
  }
  if (!current()) return null;
  const committed: RecordOf<Op> = { ...record, committed: { result } };
  updateRecord<Op>(client, projectId, record.id, (sent) => ({ ...sent, committed: { result } }));
  convergeWorkProjection(client, { kind: "entity", projectId, operation: record.operation });
  try {
    await refreshWorksSnapshot(client, projectId, () =>
      listProjectWorks(projectId, { signal: AbortSignal.timeout(COMMIT_REFRESH_TIMEOUT_MS) }),
    );
  } catch {
    // Without a fresh snapshot, what the server returned is the best truth for
    // the fields this command owns; the rest stays as last read.
    installCommittedWork(client, projectId, record.workId, (work) =>
      recordProjection(work, committed),
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

function readSnapshot(client: QueryClient, projectId: string): WorksSnapshot | undefined {
  return client.getQueryData<WorksSnapshot>(projectQueryKeys.works(projectId));
}

/**
 * A landed command drops its record and every older settled one on its Work.
 * A delete keeps its own, as its Undo window, unless the writer closed it.
 */
function retire(client: QueryClient, projectId: string, landed: RecordOf<WorkOperation>): void {
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

/** Runs a failed command again, as a new command on its Work. */
export function retryWorkCommand(
  client: QueryClient,
  projectId: string,
  failed: WorkCommandRecord,
  accountSignal: AbortSignal | null,
): Promise<Error | null> {
  const { operation, variables } = failed;
  return runWorkCommand(client, projectId, { operation, variables }, accountSignal);
}

/** The writer dismissed a failure. */
export function dismissWorkCommand(client: QueryClient, projectId: string, id: number): void {
  removeRecord(client, projectId, id);
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
