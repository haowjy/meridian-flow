/**
 * thread-snapshot-query — the one acquisition of a thread snapshot, and the read of it.
 *
 * `useThreadSnapshotSync` is the only observer of the snapshot cache key, so its guarded
 * options are the only options Query ever keeps for it: a response the host would reject
 * (wrong identity, older than live changes) throws inside the fetch and never becomes
 * cached data.
 *
 * Everything else that wants the cached snapshot or its error reads it with
 * `useThreadSnapshotCache`, which subscribes to the cache without installing an observer
 * (an observer's options would replace the host's on the shared key) and never fetches.
 */
import { hashKey, type QueryState, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { threadQueryKeys } from "./thread-query-keys";

export type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

export class StaleThreadSnapshot extends Error {}

/** What the live host adds: the account's abort signal, and the checks on a response. */
export type SnapshotGuard = {
  accountSignal: AbortSignal;
  /** Throws for a snapshot this tab must not publish (wrong identity, older than live changes). */
  accept(snapshot: ReturnType<typeof deserializeThreadSnapshot>): void;
};

/** The live host's options. Passive readers use `useThreadSnapshotCache` instead. */
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

/**
 * The cached snapshot query state for a thread (data, error, timestamps), or undefined before
 * the key exists. Observer-free: a cache subscription filtered to this key, over stable
 * `getQueryState` reads.
 */
export function useThreadSnapshotCache(
  threadId: string | null,
): QueryState<DeserializedThreadSnapshot, Error> | undefined {
  const client = useQueryClient();
  const queryKey = threadQueryKeys.snapshot(threadId ?? "");
  const hash = hashKey(queryKey);
  const subscribe = useCallback(
    (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) listener();
      }),
    [client, hash],
  );
  return useSyncExternalStore(subscribe, () =>
    client.getQueryState<DeserializedThreadSnapshot, Error>(queryKey),
  );
}
