/**
 * thread-snapshot-query — the one acquisition of a thread snapshot.
 *
 * Every producer of the snapshot cache key (the live host, the passive observers, a
 * prefetch, an invalidation that runs whichever observer's options Query kept) goes through
 * `threadSnapshotQueryOptions`, so every fetched snapshot is stamped with the reading of
 * this tab's request counter taken when its fetch started. A snapshot proves something
 * absent only when its `requestSeq` is above the reading taken when that thing was last seen,
 * so a failed, skipped or joined-older fetch proves nothing.
 */
import { queryOptions } from "@tanstack/react-query";
import { deserializeThreadSnapshot, getThreadSnapshot } from "@/client/api/threads-api";
import { threadQueryKeys } from "./thread-query-keys";

/** The wire snapshot, with the reading of the request counter taken when its fetch started. */
export type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot> & {
  requestSeq?: number;
};

let snapshotRequestsStarted = 0;

/** How many snapshot fetches this tab has started. */
export function snapshotRequestCount(): number {
  return snapshotRequestsStarted;
}

export class StaleThreadSnapshot extends Error {}

/** What the live host adds: the account's abort signal, and the checks on a response. */
export type SnapshotGuard = {
  accountSignal: AbortSignal;
  /** Throws for a snapshot this tab must not publish (wrong identity, older than live changes). */
  accept(snapshot: ReturnType<typeof deserializeThreadSnapshot>): void;
};

/**
 * Shared options for the live host and its passive observers
 * (`useMissingChatFallback`, `useDisplayedThread`, the switch ledger). Passive ones stay
 * `enabled: false`; never replace the queryFn with skipToken, which would drop the shared key.
 */
export function threadSnapshotQueryOptions(threadId: string, guard?: SnapshotGuard) {
  return queryOptions({
    queryKey: threadQueryKeys.snapshot(threadId),
    queryFn: async ({ signal }): Promise<DeserializedThreadSnapshot> => {
      snapshotRequestsStarted += 1;
      const requestSeq = snapshotRequestsStarted;
      const requestSignal = guard ? AbortSignal.any([guard.accountSignal, signal]) : signal;
      // The source check runs before TanStack Query can publish this response.
      // An obsolete HTTP success cannot become history or handoff authority.
      const snapshot = deserializeThreadSnapshot(
        await getThreadSnapshot({ data: { threadId }, signal: requestSignal }),
      );
      requestSignal.throwIfAborted();
      guard?.accept(snapshot);
      return { ...snapshot, requestSeq };
    },
  });
}
