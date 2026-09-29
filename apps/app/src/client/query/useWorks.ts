/**
 * Works reads. The query cache holds only server snapshots; readers see that
 * snapshot with every pending Work command's expected result laid over it
 * (`work-commands`).
 */
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { projectQueryKeys } from "./project-query-keys";
import { useIsProjectPendingCreation } from "./useProjectCreation";
import { commandProjection, useWorkCommandRecords, type WorkCommandRecord } from "./work-commands";
import { acquireWorksSnapshot, workFromSnapshot } from "./works-projection-acquisition";

export { workFromSnapshot };

/** The server snapshot alone, with no command laid over it. */
export function useWorksSnapshot(projectId: string, requested = true) {
  const enabled = requested && !useIsProjectPendingCreation(projectId);
  const client = useQueryClient();
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => acquireWorksSnapshot(client, projectId),
    staleTime: 30_000,
    enabled,
  });
  return { list, enabled };
}

export function useWorks(projectId: string, options?: { enabled?: boolean }) {
  const { list, enabled } = useWorksSnapshot(projectId, options?.enabled);
  const records = useWorkCommandRecords(projectId);
  const snapshot = useMemo(
    () => (list.data ? projectPendingCommands(list.data, records) : undefined),
    [list.data, records],
  );
  const works = useMemo(
    () => snapshot?.works.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null),
    [snapshot?.works, list.isError],
  );
  // Soft-deleted Works stay restorable until their purge date; newest first.
  const deleted = useMemo(
    () =>
      (snapshot?.works.filter((work) => work.deletedAt !== null) ?? []).sort((a, b) =>
        (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
      ),
    [snapshot?.works],
  );
  const noWork = snapshot?.noWork ?? null;
  const refetch = useCallback(() => void list.refetch(), [list.refetch]);
  const status = !enabled
    ? "disabled"
    : list.isError
      ? "error"
      : !list.data
        ? "loading"
        : works?.length === 0
          ? "empty"
          : "ready";
  return {
    works,
    deleted,
    noWork,
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}

/** Each Work with every pending command's expected result laid over it. */
function projectPendingCommands(
  snapshot: WorksSnapshot,
  records: readonly WorkCommandRecord[],
): WorksSnapshot {
  const fields = new Map<string, Partial<Work>>();
  for (const record of records) {
    if (record.status !== "pending") continue;
    fields.set(record.workId, { ...fields.get(record.workId), ...commandProjection(record) });
  }
  if (!fields.size) return snapshot;
  const patch = <T extends Work>(work: T): T => {
    const next = fields.get(work.id);
    return next ? ({ ...work, ...next } as T) : work;
  };
  return { ...snapshot, works: snapshot.works.map(patch), noWork: patch(snapshot.noWork) };
}
