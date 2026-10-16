/**
 * useThreadSnapshotSync — the binding of the chat's `ThreadSync` to React.
 *
 * `createThreadSync` (in `@meridian/thread-client/sync`) is the chat's one mounted subscriber and
 * decides when to read, what is missing, how a read applies and joins the stream, and in what
 * order frames reach the turns. This hook gives it the app's ports: the store's cell for the
 * chat's value, React Query as the fetcher, the account signal, and the store's effects as its
 * observer. It starts the sync once the chat is no longer pending creation and stops it on
 * cleanup. React Query's `queryFn` hands every completed read to `sync.receive`, so the cache
 * publishes only reads the sync applied.
 */
import { acceptsSnapshot, createThreadSync, SNAPSHOT_RETRY_MS } from "@meridian/thread-client/sync";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { threadQueryKeys } from "./thread-query-keys";
import {
  type DeserializedThreadSnapshot,
  StaleThreadSnapshot,
  threadSnapshotQueryOptions,
} from "./thread-snapshot-query";

export type ThreadSnapshotSyncStatus = {
  snapshot: DeserializedThreadSnapshot | null;
  thread: DeserializedThreadSnapshot["thread"] | null;
  liveState: DeserializedThreadSnapshot["liveState"] | null;
  actionRequired: DeserializedThreadSnapshot["actionRequired"] | null;
  nextSeq: DeserializedThreadSnapshot["nextSeq"] | null;
  /**
   * The thread's history is in the transcript store (or its load failed). Not
   * merely fetched: a render can see the accepted snapshot a commit before its
   * turns reach the store, and a reader that took that for "history is empty"
   * would give up on a turn that is about to arrive.
   */
  settled: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

/** Pending creation gates HTTP and automatic subscription through first-send admission. */
export function useThreadSnapshotSync(threadId: string): ThreadSnapshotSyncStatus {
  const actions = useThreadActions();
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const accountSignal = useAccountEpochSignal();
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const binding = useMemo(() => {
    const ports = actions.syncPorts(threadId);
    let request: (kind: "fresh" | "any") => void = () => undefined;
    const sync = createThreadSync({
      threadId,
      transport,
      ...ports,
      signal: accountSignal,
      requestSnapshot: (kind) => request(kind),
    });
    return {
      sync,
      state: ports.state,
      /** Late-bound: the query that fetches is built after the sync that needs to ask it. */
      bind(next: (kind: "fresh" | "any") => void) {
        request = next;
      },
    };
  }, [accountSignal, actions, threadId, transport]);

  const { data, isError, isFetching, refetch } = useQuery({
    ...threadSnapshotQueryOptions(threadId, {
      accountSignal,
      accept(snapshot) {
        if (snapshot.thread.id !== threadId || snapshot.thread.userId !== accountId) {
          throw new Error("Thread snapshot identity mismatch");
        }
        // The sync applies the read; React Query publishes only what it applied.
        if (binding.sync.receive(snapshot) === "stale") {
          throw new StaleThreadSnapshot("Thread snapshot is older than live changes");
        }
      },
    }),
    // Always revalidate on activation: the thread may have advanced while the
    // writer was elsewhere (for example a background child's report waking the
    // parent). Cached turns still render first, so this stays navigate-first.
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !isPendingCreation && !accountSignal.aborted,
    retry: (_failureCount, error) => error instanceof StaleThreadSnapshot && !accountSignal.aborted,
    retryDelay: SNAPSHOT_RETRY_MS,
  });

  // Asked in a microtask, as the cache port defers: a request can come from inside a write.
  binding.bind((kind) =>
    queueMicrotask(() => {
      if (accountSignal.aborted) return;
      if (kind === "any") {
        void refetch({ cancelRefetch: false });
        return;
      }
      // A fresh read cancels the one in flight, but React Query hands the first read back
      // instead: it started before this request, so follow it with one more.
      const firstInFlight = queryClient.getQueryState(threadQueryKeys.snapshot(threadId));
      const again = firstInFlight?.data === undefined && firstInFlight?.fetchStatus === "fetching";
      const read = refetch();
      if (again) {
        void read.then(() => {
          if (!accountSignal.aborted) void refetch();
        });
      }
    }),
  );

  const latest = useRef(data);
  latest.current = data;

  // The sync's lifetime is independent of the pending-creation flag. A commit that
  // clears that flag must not stop the handler installed by first send.
  useLayoutEffect(() => () => binding.sync.stop(), [binding]);
  useLayoutEffect(() => {
    if (isPendingCreation) return;
    binding.sync.start();
    // The store was recreated under a kept QueryClient: the cache holds a read the cell lacks.
    const cached = latest.current;
    if (
      cached &&
      cached.thread.id === threadId &&
      cached.thread.userId === accountId &&
      binding.state.get().runState.history === null &&
      binding.sync.receive(cached) === "applied"
    ) {
      rerender();
    }
  }, [accountId, binding, isPendingCreation, threadId]);

  const accepted =
    !accountSignal.aborted &&
    data?.thread.id === threadId &&
    data.thread.userId === accountId &&
    acceptsSnapshot(binding.state.get(), data.nextSeq);
  const snapshot = accepted ? data : null;
  const settled = binding.state.get().runState.history !== null || isError;

  return {
    snapshot,
    thread: snapshot?.thread ?? null,
    liveState: snapshot?.liveState ?? null,
    actionRequired: snapshot?.actionRequired ?? null,
    nextSeq: snapshot?.nextSeq ?? null,
    settled,
    isError,
    isFetching,
    refetch: () => {
      if (!accountSignal.aborted) void refetch();
    },
  };
}
