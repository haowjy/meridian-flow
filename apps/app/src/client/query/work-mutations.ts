/**
 * What a screen does with Work commands: submit one to the command driver and read the records
 * the driver holds. A command's promise resolves when the server has settled it (`null`), or to
 * its failure, so a caller can reopen the field it edited; the record itself outlives the
 * screen and is shown by `work-command-selectors`. The Undo windows of deleted Works are this
 * tab's: they last until the writer's next action there.
 */
import type { CommandDriver } from "@meridian/command-driver";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useCommandDriver, useCommands } from "@/client/commands/driver-context";
import { DeviceRefusedError, submitCommand } from "@/client/commands/submit";
import { projectQueryKeys } from "./project-query-keys";
import {
  type ReturnedWhy,
  WORK_KINDS,
  type WorkCommandRecord,
  type WorkCommandVariables,
  type WorkOperation,
  workCommandOf,
  workCommandSpecs,
  workKindOf,
  workLanes,
} from "./work-commands";

/** The server turned a command away; `code` is its error code (`work_locked`, `work_not_found`). */
export class WorkCommandRefused extends Error {
  readonly name = "WorkCommandRefused";
  constructor(readonly code: string | null) {
    super(`Work command refused${code ? `: ${code}` : ""}`);
  }

  /** Only a refusal the server did not explain can succeed on a second try: the others ran and were turned away. */
  get retryable(): boolean {
    return this.code === null;
  }
}

/** The server left a closed Work as it stands: the writer's change did not apply. */
export class WorkReturnedError extends Error {
  readonly name = "WorkReturnedError";
  constructor(readonly why: ReturnedWhy) {
    super(why);
  }
}

/** A command resolves to its failure, or `null` once the server has it. */
export type RunWorkCommand<Op extends WorkOperation> = (
  variables: WorkCommandVariables[Op],
  /** `saved` runs once the command is in the journal: where a destination may open. */
  options?: { saved?: () => void },
) => Promise<Error | null>;

export type WorkMutations = { [Op in WorkOperation]: RunWorkCommand<Op> };

export function useWorkMutations(projectId: string): WorkMutations {
  const driver = useCommandDriver();
  const client = useQueryClient();
  return useMemo(() => {
    const command =
      <Op extends WorkOperation>(operation: Op): RunWorkCommand<Op> =>
      (variables, options) =>
        runWorkCommand(client, driver, projectId, operation, variables, options?.saved);
    return {
      create: command("create"),
      update: command("update"),
      archive: command("archive"),
      unarchive: command("unarchive"),
      delete: command("delete"),
      restore: command("restore"),
    };
  }, [client, driver, projectId]);
}

/** This project's Work commands the driver holds, oldest first. */
export function useWorkCommandRecords(projectId: string): readonly WorkCommandRecord[] {
  const records = useCommands();
  return useMemo(
    () =>
      records.flatMap((record) => {
        const command = WORK_KINDS.has(record.kind) ? workCommandOf(record) : null;
        return command?.projectId === projectId ? [command] : [];
      }),
    [records, projectId],
  );
}

async function runWorkCommand<Op extends WorkOperation>(
  client: QueryClient,
  driver: CommandDriver | null,
  projectId: string,
  operation: Op,
  variables: WorkCommandVariables[Op],
  saved?: () => void,
): Promise<Error | null> {
  if (!driver) return new Error("Commands are not available yet");
  const { workId } = variables;
  // A new command replaces what its Work showed before.
  for (const record of driver.getSnapshot().records) {
    const old = WORK_KINDS.has(record.kind) ? workCommandOf(record) : null;
    if (old?.state === "never" && old.workId === workId) void driver.dismiss(old.id);
  }
  const record = await submitCommand(driver, {
    kind: workKindOf(operation),
    lanes: workLanes(projectId, workId),
    body: { projectId, variables },
  });
  if (!record) return new DeviceRefusedError();
  const { id } = record;
  saved?.();
  if (operation === "delete")
    openDeleteWindow(client, projectId, { workId, commandId: id, openedAt: Date.now() });
  const settled = await driver.whenSettled(id);
  if (operation === "restore" && settled?.state === "done") closeWindows(client, projectId, workId);
  if (!settled) return new Error("The command was removed before it settled");
  const failed = workCommandOf(settled);
  // A closed Work answers `done` with nothing changed: the field reopens like a refusal.
  if (failed?.returned) {
    if (!workCommandSpecs[operation].keepsFailure) void driver.dismiss(id);
    return new WorkReturnedError(failed.returned);
  }
  if (settled.state !== "never") return null;
  if (!workCommandSpecs[operation].keepsFailure) void driver.dismiss(id);
  return refusedBy(failed);
}

const refusedBy = (record: WorkCommandRecord | null) =>
  new WorkCommandRefused(record?.code ?? null);

/** Runs a refused command again, in its place. Resolves to its failure, or `null`. */
export async function retryWorkCommand(
  driver: CommandDriver,
  failed: WorkCommandRecord,
): Promise<Error | null> {
  await driver.retry(failed.id);
  const settled = await driver.whenSettled(failed.id);
  if (!settled) return new Error("The command was removed before it settled");
  return settled.state === "never" ? refusedBy(workCommandOf(settled)) : null;
}

export function dismissWorkCommand(driver: CommandDriver, id: string): void {
  void driver.dismiss(id);
}

// --- Undo windows of deleted Works ---

export type WorkDeleteWindowEntry = { workId: string; commandId: string; openedAt: number };

const NO_WINDOWS: readonly WorkDeleteWindowEntry[] = [];

const windowsKey = (projectId: string) =>
  [...projectQueryKeys.workCommands(projectId), "windows"] as const;

function readWindows(client: QueryClient, projectId: string): readonly WorkDeleteWindowEntry[] {
  return client.getQueryData<readonly WorkDeleteWindowEntry[]>(windowsKey(projectId)) ?? NO_WINDOWS;
}

function openDeleteWindow(
  client: QueryClient,
  projectId: string,
  entry: WorkDeleteWindowEntry,
): void {
  client.setQueryData(windowsKey(projectId), [...readWindows(client, projectId), entry]);
}

function closeWindows(client: QueryClient, projectId: string, workId: string): void {
  client.setQueryData(
    windowsKey(projectId),
    readWindows(client, projectId).filter((entry) => entry.workId !== workId),
  );
}

export function useWorkDeleteWindowEntries(projectId: string): readonly WorkDeleteWindowEntry[] {
  const client = useQueryClient();
  return useQuery({
    queryKey: windowsKey(projectId),
    queryFn: () => readWindows(client, projectId),
    initialData: () => readWindows(client, projectId),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

/** The writer closed a Work's Undo window: it and any refused Undo go. */
export function closeWorkDeleteWindow(
  client: QueryClient,
  driver: CommandDriver | null,
  projectId: string,
  workId: string,
): void {
  closeWindows(client, projectId, workId);
  for (const record of driver?.getSnapshot().records ?? []) {
    const old = WORK_KINDS.has(record.kind) ? workCommandOf(record) : null;
    if (old?.state === "never" && old.workId === workId && old.operation === "restore")
      void driver?.dismiss(old.id);
  }
}
