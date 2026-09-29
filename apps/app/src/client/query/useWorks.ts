/**
 * Works reads. The query cache holds only server snapshots; readers see that
 * snapshot with every pending Work command laid over it (`work-commands`),
 * and the Works still being created beside it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { projectQueryKeys } from "./project-query-keys";
import { useIsProjectPendingCreation } from "./useProjectCreation";
import { projectWorkCommands, useWorkCommandRecords } from "./work-commands";
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
  const projected = useMemo(
    () => projectWorkCommands(projectId, list.data, records),
    [projectId, list.data, records],
  );
  const snapshot = projected.snapshot;
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
    /** Works still being created; `works` leaves them out until the server has them. */
    creations: projected.creations,
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}
