/**
 * useThreadSnapshotSync — authoritative history and mounted-thread block projection.
 *
 * The hook owns one addressed durable-block subscriber for its mounted lifetime;
 * the run controller keeps stream deltas and commands. Explicit activation
 * installs that owner synchronously after first-send admission succeeds.
 */
import { EventType, parseSeq } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import {
  deserializeThreadSnapshot,
  getThreadSnapshot,
  toThreadSnapshotApplyOptions,
} from "@/client/api/threads-api";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import {
  applyDurableBlockEvent,
  isDurableBlockEvent,
  isWellFormedDurableBlockEvent,
} from "@/core/session/reduce-turn-event";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { threadQueryKeys } from "./thread-query-keys";

type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

class StaleThreadSnapshot extends Error {}

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
  /** Registers this mounted owner's durable handler before returning. */
  activateProjection: (after?: string) => boolean;
};

/** Pending creation gates HTTP and automatic subscription through first-send admission. */
export function useThreadSnapshotSync(threadId: string): ThreadSnapshotSyncStatus {
  const actions = useThreadActions();
  const controller = useMeridianAgent();
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const accountSignal = useAccountEpochSignal();
  const accountId = useAccountId();

  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: threadQueryKeys.snapshot(threadId),
    queryFn: async ({ signal }) => {
      const requestSignal = AbortSignal.any([accountSignal, signal]);
      // The source check runs before TanStack Query can publish this response.
      // An obsolete HTTP success cannot become history or handoff authority.
      const snapshot = deserializeThreadSnapshot(
        await getThreadSnapshot({ data: { threadId }, signal: requestSignal }),
      );
      requestSignal.throwIfAborted();
      if (snapshot.thread.id !== threadId || snapshot.thread.userId !== accountId) {
        throw new Error("Thread snapshot identity mismatch");
      }
      if (!actions.acceptsThreadSnapshot(threadId, snapshot.nextSeq)) {
        throw new StaleThreadSnapshot("Thread snapshot is older than live changes");
      }
      return snapshot;
    },
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !isPendingCreation && !accountSignal.aborted,
    retry: (_failureCount, error) => error instanceof StaleThreadSnapshot && !accountSignal.aborted,
    retryDelay: 250,
  });

  const owner = useMemo(() => {
    let mounted = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    let refreshQuery: () => void = () => undefined;
    const current = (expected: number) =>
      mounted && !accountSignal.aborted && generation === expected;
    const refresh = (expected: number) => {
      if (!current(expected) || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (current(expected)) refreshQuery();
      }, 250);
    };
    return {
      setRefetch(next: () => void) {
        refreshQuery = next;
      },
      mount() {
        mounted = true;
      },
      activate(after?: string): boolean {
        if (!mounted || accountSignal.aborted) return false;
        if (unsubscribe) return true;
        const expected = generation;
        let acquired: (() => void) | null = null;
        try {
          acquired = transport.subscribe(
            threadId,
            {
              onEvent: ({ event, seq, sourceThreadId }) => {
                if (!current(expected) || (sourceThreadId && sourceThreadId !== threadId)) return;
                if ("threadId" in event && event.threadId !== threadId) return;
                if (event.type === EventType.RUN_STARTED) refresh(expected);
                if (
                  !isDurableBlockEvent(event) ||
                  !isWellFormedDurableBlockEvent(event) ||
                  parseSeq(seq) === null
                )
                  return;
                controller.flushPendingDeltas(threadId);
                if (!current(expected) || !actions.acceptDurableBlockSeq(threadId, seq)) return;
                applyDurableBlockEvent(actions, threadId, event);
              },
              onGap: () => refresh(expected),
            },
            after === undefined ? undefined : { after },
          );
          if (!current(expected)) {
            acquired();
            return false;
          }
          unsubscribe = acquired;
          return true;
        } catch (error) {
          acquired?.();
          throw error;
        }
      },
      dispose() {
        mounted = false;
        generation += 1;
        if (timer) clearTimeout(timer);
        timer = null;
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }, [accountSignal, actions, controller, threadId, transport]);
  owner.setRefetch(() => {
    if (!accountSignal.aborted) void refetch();
  });

  // Owner lifetime is independent of the pending-creation flag. A commit that
  // clears that flag must not dispose the handler installed by first send.
  useLayoutEffect(() => {
    owner.mount();
    return () => owner.dispose();
  }, [owner]);
  useLayoutEffect(() => {
    if (!isPendingCreation) owner.activate();
  }, [isPendingCreation, owner]);

  const accepted =
    !accountSignal.aborted &&
    data?.thread.id === threadId &&
    data.thread.userId === accountId &&
    actions.acceptsThreadSnapshot(threadId, data.nextSeq);
  const snapshot = accepted ? data : null;
  useLayoutEffect(() => {
    if (!snapshot || accountSignal.aborted) return;
    actions.applyThreadSnapshot(
      snapshot.thread,
      snapshot.turns,
      toThreadSnapshotApplyOptions(snapshot),
    );
  }, [accountSignal, actions, snapshot]);

  return {
    snapshot,
    thread: snapshot?.thread ?? null,
    liveState: snapshot?.liveState ?? null,
    actionRequired: snapshot?.actionRequired ?? null,
    nextSeq: snapshot?.nextSeq ?? null,
    settled: snapshot !== null || isError,
    isError,
    isFetching,
    refetch: () => {
      if (!accountSignal.aborted) void refetch();
    },
    activateProjection: owner.activate,
  };
}
