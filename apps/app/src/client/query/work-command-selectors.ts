/**
 * What the Work command records leave for the writer to see: each Work's
 * failed command, each deleted Work's Undo window, and the Works being
 * restored. Every surface reads the same records, so the list and the band
 * agree.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { useWorksSnapshot } from "./useWorks";
import {
  dismissWorkCommand,
  retryWorkCommand,
  snapshotHasCommandTarget,
  useWorkCommandRecords,
  type WorkCommandRecord,
  type WorkOperation,
} from "./work-commands";

export type WorkCommandFailure<Op extends WorkOperation = WorkOperation> = {
  workId: string;
  operation: Op;
  error: Error;
  /** Runs the command again; resolves to its failure, or `null`. */
  retry: () => Promise<Error | null>;
  dismiss: () => void;
};

/**
 * The failed command each Work still shows, keyed by Work id. A Work's latest
 * command wins, so a retry or any newer command on it replaces the failure,
 * and a failure goes quiet once the server already shows its target (another
 * device archived the Work, say). `operations` is a module constant.
 */
export function useWorkCommandFailures<Op extends WorkOperation>(
  projectId: string,
  operations: readonly Op[],
): ReadonlyMap<string, WorkCommandFailure<Op>> {
  const client = useQueryClient();
  const accountSignal = useOptionalAccountEpochSignal();
  const server = useWorksSnapshot(projectId).list.data;
  const records = useWorkCommandRecords(projectId);
  return useMemo(() => {
    const failures = new Map<string, WorkCommandFailure<Op>>();
    for (const record of latestByWork(records).values()) {
      if (record.status !== "failed" || !record.error) continue;
      if (!(operations as readonly WorkOperation[]).includes(record.operation)) continue;
      if (snapshotHasCommandTarget(server, record)) continue;
      failures.set(record.workId, {
        workId: record.workId,
        operation: record.operation as Op,
        error: record.error,
        retry: () => retryWorkCommand(client, projectId, record, accountSignal),
        dismiss: () => dismissWorkCommand(client, projectId, record.id),
      });
    }
    return failures;
  }, [accountSignal, client, operations, projectId, records, server]);
}

function latestByWork(records: readonly WorkCommandRecord[]) {
  const latest = new Map<string, WorkCommandRecord>();
  for (const record of records) latest.set(record.workId, record);
  return latest;
}

/**
 * A deleted Work's Undo window: open from the delete until the writer undoes
 * or dismisses it. A rejected Undo reopens it with that error.
 */
export type WorkDeleteWindow = { workId: string; undoError: Error | null };

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
      if (remove.status === "failed" || remove.dismissed) continue;
      // An Undo on its way shows as the Work restoring in its tab.
      if (after.some((record) => record.status !== "failed")) continue;
      // Restored elsewhere: the Work is back, so there is nothing to undo.
      if (remove.status === "done" && server && !snapshotHasCommandTarget(server, remove)) continue;
      const undo = after.filter((record) => record.operation === "restore").at(-1);
      windows.push({ workId, undoError: undo?.error ?? null });
    }
    return windows;
  }, [records, server]);
}

/** Works whose restore is still on its way; they already show in their tab. */
export function useRestoringWorkIds(projectId: string): ReadonlySet<string> {
  const records = useWorkCommandRecords(projectId);
  return useMemo(
    () =>
      new Set(
        records
          .filter((record) => record.operation === "restore" && record.status === "pending")
          .map((record) => record.workId),
      ),
    [records],
  );
}
