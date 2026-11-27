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

export type AddressableWork = Work & { id: ParsedRequestId };

const isAddressable = <W extends Work>(work: W): work is W & AddressableWork => isUuid(work.id);

export function useWorksSnapshot(projectId: string, requested = true) {
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
  const addressable = useMemo(() => snapshot?.works.filter(isAddressable), [snapshot?.works]);
  const works = useMemo(
    () => addressable?.filter((work) => work.deletedAt === null) ?? (list.isError ? [] : null),
    [addressable, list.isError],
  );
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
    handleOf,
    nameOf,
    creations: projected.creations,
    isError: list.isError,
    isFetching: list.isFetching,
    status: status as "disabled" | "error" | "loading" | "empty" | "ready",
    refetch,
  };
}
