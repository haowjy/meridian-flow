import { hashKey, type QueryState, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { threadQueryKeys } from "./thread-query-keys";

export type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

export class StaleThreadSnapshot extends Error {}

export type SnapshotGuard = {
  accountSignal: AbortSignal;
  accept(snapshot: ReturnType<typeof deserializeThreadSnapshot>): void;
};

export function threadSnapshotQueryOptions(threadId: string, guard?: SnapshotGuard) {
  return queryOptions({
    queryKey: threadQueryKeys.snapshot(threadId),
    queryFn: async ({ signal }): Promise<DeserializedThreadSnapshot> => {
      const requestSignal = guard ? AbortSignal.any([guard.accountSignal, signal]) : signal;
      // A response the guard rejects throws here, so Query never publishes it: an obsolete
      // HTTP success cannot become history or handoff authority.
      const snapshot = deserializeThreadSnapshot(
        await getThreadSnapshot({ data: { threadId }, signal: requestSignal }),
      );
      requestSignal.throwIfAborted();
      guard?.accept(snapshot);
      return snapshot;
    },
  });
}

export function useThreadSnapshotCache(
  threadId: string | null,
): QueryState<DeserializedThreadSnapshot, Error> | undefined {
  const client = useQueryClient();
  const queryKey = threadQueryKeys.snapshot(threadId ?? "");
  const hash = hashKey(queryKey);
  const subscribe = useCallback(
    (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        // Notify on state changes (`updated`) and removal (`removed`, e.g. account close). `added`
        // and `observerResultsUpdated` fire synchronously inside another component's render (its
        // `useQuery` builds and reads the query), and notifying then updates this store
        // mid-render. `removed` comes from an effect, event handler or GC timer, never a render.
        if (
          (event.type === "updated" || event.type === "removed") &&
          event.query.queryHash === hash
        )
          listener();
      }),
    [client, hash],
  );
  return useSyncExternalStore(subscribe, () =>
    client.getQueryState<DeserializedThreadSnapshot, Error>(queryKey),
  );
}
