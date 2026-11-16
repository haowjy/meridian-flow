/**
 * Works reads. The query cache holds only server snapshots; readers see that
 * snapshot with every pending Work command laid over it (`work-command-projection`),
 * and the Works still being created beside it.
 */
import { isUuid, type ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { repeatedNameHandles, workNameWith } from "@/lib/work-name";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { projectWorkCommands } from "./work-command-projection";
import { useWorkCommandRecords } from "./work-mutations";
import { acquireWorksSnapshot, workFromSnapshot } from "./works-projection-acquisition";

export { workFromSnapshot };

/** A Work whose id is a checked request id, so it can go into an address as is. */
export type AddressableWork = Work & { id: ParsedRequestId };

const isAddressable = <W extends Work>(work: W): work is W & AddressableWork => isUuid(work.id);

/** The server snapshot alone, with no command laid over it. */
export function useWorksSnapshot(projectId: string, requested = true) {
  // Called unconditionally: short-circuiting a hook behind `requested` changes
  // the hook order the moment a caller flips it.
  const enabled = requested;
  const client = useQueryClient();
  const list = useQuery({
    queryKey: projectQueryKeys.works(projectId),
    queryFn: () => acquireWorksSnapshot(client, projectId),
    staleTime: 30_000,
    // A read that failed while offline leaves its error beside data that is still fresh, so
    // reconnecting would not refetch on staleness alone.
    refetchOnReconnect: "always",
    enabled: projectReadEnabled(requested),
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
  const handleOf = useMemo(() => repeatedNameHandles(addressable ?? []), [addressable]);
  const nameOf = useMemo(() => workNameWith(handleOf), [handleOf]);
  const noWork = snapshot?.noWork && isAddressable(snapshot.noWork) ? snapshot.noWork : null;
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
    /** The handle beside a Work's name where another Work shares it (`repeatedNameHandles`). */
    handleOf,
    /** A Work's name as a string, its handle included where it shows one (`WorkName` draws it). */
    nameOf,
    /** Works still being created; `works` leaves them out until the server has them. */
    creations: projected.creations,
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}
