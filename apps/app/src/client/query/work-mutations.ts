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

export class WorkCommandRefused extends Error {
  readonly name = "WorkCommandRefused";
  constructor(readonly code: string | null) {
    super(`Work command refused${code ? `: ${code}` : ""}`);
  }

  get retryable(): boolean {
    return this.code === null;
  }
}

export class WorkReturnedError extends Error {
  readonly name = "WorkReturnedError";
  constructor(readonly why: ReturnedWhy) {
    super(why);
  }
}

export type RunWorkCommand<Op extends WorkOperation> = (
  variables: WorkCommandVariables[Op],
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
  for (const record of driver.getSnapshot().records) {
    const old = WORK_KINDS.has(record.kind) ? workCommandOf(record) : null;
    if (old?.state === "never" && old.workId === workId) void driver.dismiss(old.id);
  }
  const record = await submitCommand(driver, {
    kind: workKindOf(operation),
    lanes: (records) => workLanes(operation, projectId, workId, records),
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
