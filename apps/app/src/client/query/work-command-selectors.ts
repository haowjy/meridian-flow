/**
 * What the Work commands leave for the writer to see: each Work's failed
 * command, each deleted Work's Undo window, and the Works being restored.
 * Every surface reads the same records, so the list and the band agree.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useWorksSnapshot } from "./useWorks";
import {
  removeWorkCommand,
  snapshotHasCommandTarget,
  useWorkCommandRecords,
  type WorkCommandRecord,
  type WorkOperation,
  workCommandsOn,
} from "./work-commands";

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
 * device archived the Work, say).
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
