/**
 * What the Work command records leave for the writer to see: each Work's failed command, each
 * deleted Work's Undo window, and the Works being restored. Every surface reads the same
 * records, so the list and the band agree.
 */
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
  /** Runs the command again; resolves to its failure, or `null`. */
  retry: () => Promise<Error | null>;
  dismiss: () => void;
};

/**
 * The failed command each Work still shows, keyed by Work id. A Work's latest command wins, so
 * a retry or any newer command on it replaces the failure, and a failure goes quiet once the
 * server already shows its target (another device archived the Work, say). `operations` is a
 * module constant.
 */
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
        error: new WorkCommandRefused(record.reason, record.refusalState),
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

/**
 * A deleted Work's Undo window: open from the delete until the writer undoes or closes it. A
 * refused Undo reopens it; its failure is the Work's restore failure.
 */
export type WorkDeleteWindow = { workId: string };

/** Every open Undo window in this project, oldest delete first. */
export function useWorkDeleteWindows(projectId: string): readonly WorkDeleteWindow[] {
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  const entries = useWorkDeleteWindowEntries(projectId);
  return useMemo(() => {
    const windows: WorkDeleteWindow[] = [];
    for (const { workId, commandId, openedAt } of entries) {
      const remove = records.find((record) => record.id === commandId);
      // A refused delete is the Work's failure, not an Undo.
      if (remove?.state === "never") continue;
      // An Undo on its way shows as the Work restoring in its tab.
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
      // Restored elsewhere: the Work is back, so there is nothing to undo.
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

/** Works whose restore is still on its way; they already show in their tab. */
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
