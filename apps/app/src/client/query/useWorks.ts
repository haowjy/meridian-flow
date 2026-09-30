/**
 * Works reads. The query cache holds only server snapshots; readers see that
 * snapshot with every pending Work command laid over it (`work-command-projection`),
 * and the Works still being created beside it.
 */
import { isUuid, type ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { projectQueryKeys } from "./project-query-keys";
import { useIsProjectPendingCreation } from "./useProjectCreation";
import { projectWorkCommands } from "./work-command-projection";
import { useWorkCommandRecords } from "./work-command-store";
import { acquireWorksSnapshot, workFromSnapshot } from "./works-projection-acquisition";

export { workFromSnapshot };

/** A Work whose id is a checked request id, so it can go into an address as is. */
export type AddressableWork = Work & { id: ParsedRequestId };

const isAddressable = <W extends Work>(work: W): work is W & AddressableWork => isUuid(work.id);

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
  const projected = useMemo(() => projectWorkCommands(list.data, records), [list.data, records]);
  const snapshot = projected.snapshot;
  // Work ids are checked once here; every reader can address a Work by its id.
  const addressable = useMemo(() => snapshot?.works.filter(isAddressable), [snapshot?.works]);
  const works = useMemo(
    () => addressable?.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null),
    [addressable, list.isError],
  );
  // Soft-deleted Works stay restorable until their purge date; newest first.
  const deleted = useMemo(
    () =>
      (addressable?.filter((work) => work.deletedAt !== null) ?? []).sort((a, b) =>
        (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
      ),
    [addressable],
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
