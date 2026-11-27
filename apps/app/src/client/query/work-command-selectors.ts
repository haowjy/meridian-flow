import { useMemo } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { useWorksSnapshot } from "./useWorks";
import { snapshotHasCommandTarget } from "./work-command-projection";
import type { WorkCommandRecord, WorkOperation } from "./work-commands";
import {
  dismissWorkCommand,
  retryWorkCommand,
  useWorkCommandRecords,
  useWorkDeleteWindowEntries,
  WorkCommandRefused,
} from "./work-mutations";

export type WorkCommandFailure<Op extends WorkOperation = WorkOperation> = {
  workId: string;
  operation: Op;
  error: WorkCommandRefused;
  name?: string;
  retry: () => Promise<Error | null>;
  dismiss: () => void;
};

export function useWorkCommandFailures<Op extends WorkOperation>(
  projectId: string,
  operations: readonly Op[],
): ReadonlyMap<string, WorkCommandFailure<Op>> {
  const driver = useCommandDriver();
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  return useMemo(() => {
    const failures = new Map<string, WorkCommandFailure<Op>>();
    if (!driver) return failures;
    for (const record of latestByWork(records).values()) {
      if (record.state !== "never") continue;
      if (!(operations as readonly WorkOperation[]).includes(record.operation)) continue;
      if (snapshotHasCommandTarget(server, record)) continue;
      failures.set(record.workId, {
        workId: record.workId,
        operation: record.operation as Op,
        error: new WorkCommandRefused(record.code),
        name: record.operation === "restore" ? record.variables.name : undefined,
        retry: () => retryWorkCommand(driver, record),
        dismiss: () => dismissWorkCommand(driver, record.id),
      });
    }
    return failures;
  }, [driver, operations, records, server]);
}

function latestByWork(records: readonly WorkCommandRecord[]) {
  const latest = new Map<string, WorkCommandRecord>();
  for (const record of records) latest.set(record.workId, record);
  return latest;
}

export type WorkDeleteWindow = { workId: string };

export function useWorkDeleteWindows(projectId: string): readonly WorkDeleteWindow[] {
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  const entries = useWorkDeleteWindowEntries(projectId);
  return useMemo(() => {
    const windows: WorkDeleteWindow[] = [];
    for (const { workId, commandId, openedAt } of entries) {
      const remove = records.find((record) => record.id === commandId);
      if (remove?.state === "never") continue;
      if (
        records.some(
          (record) =>
            record.workId === workId &&
            record.operation === "restore" &&
            record.since >= openedAt &&
            record.state !== "never",
        )
      )
        continue;
      if (
        remove?.state !== "sending" &&
        server &&
        !snapshotHasCommandTarget(server, { operation: "delete", variables: { workId } })
      )
        continue;
      windows.push({ workId });
    }
    return windows;
  }, [entries, records, server]);
}

export function useRestoringWorkIds(projectId: string): ReadonlySet<string> {
  const records = useWorkCommandRecords(projectId);
  return useMemo(
    () =>
      new Set(
        records
          .filter((record) => record.operation === "restore" && record.state === "sending")
          .map((record) => record.workId),
      ),
    [records],
  );
}
