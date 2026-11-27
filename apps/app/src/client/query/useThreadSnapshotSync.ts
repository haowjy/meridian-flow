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
  settled: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

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
      epoch: 0,
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
        if (binding.sync.receive(snapshot) === "stale") {
          throw new StaleThreadSnapshot("Thread snapshot is older than live changes");
        }
      },
    }),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    enabled: !isPendingCreation && !accountSignal.aborted,
    retry: (_failureCount, error) => error instanceof StaleThreadSnapshot && !accountSignal.aborted,
    retryDelay: SNAPSHOT_RETRY_MS,
  });

  // Asked in a microtask, as the cache port defers: a request can come from inside a write.
  binding.bind((kind) => {
    const mounted = binding.epoch;
    const live = () => !accountSignal.aborted && binding.epoch === mounted;
    queueMicrotask(() => {
      if (!live()) return;
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
          if (live()) void refetch();
        });
      }
    });
  });

  const latest = useRef(data);
  latest.current = data;

  // The sync's lifetime is independent of the pending-creation flag. A commit that
  // clears that flag must not stop the handler installed by first send.
  useLayoutEffect(
    () => () => {
      binding.epoch += 1;
      binding.sync.stop();
    },
    [binding],
  );
  useLayoutEffect(() => {
    if (isPendingCreation) return;
    const cached = latest.current;
    const held =
      cached &&
      cached.thread.id === threadId &&
      cached.thread.userId === accountId &&
      !queryClient.getQueryState(threadQueryKeys.snapshot(threadId))?.isInvalidated
        ? cached
        : undefined;
    if (binding.sync.start(held)) rerender();
  }, [accountId, binding, isPendingCreation, queryClient, threadId]);

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
