/**
 * useThreadSnapshotSync — authoritative history and mounted-thread block projection.
 *
 * The hook owns one addressed durable-block subscriber for its mounted lifetime;
 * the run controller keeps stream deltas and commands. Every accepted snapshot
 * and live pending inbox frame also feeds the run controller's follow rule. Explicit activation
 * installs that owner synchronously after first-send admission succeeds.
 */
import {
  compareSeq,
  EventType,
  EXECUTION_ENDED_EVENT,
  MESSAGES_HANDED_BACK_EVENT,
  parseSeq,
  RUN_STATE_EVENT,
  readRunState,
  WRITE_MODE_SWITCHED_EVENT,
} from "@meridian/contracts/protocol";
import { isDurableBlockEvent, isWellFormedDurableBlockEvent } from "@meridian/thread-client";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useState } from "react";
import { toThreadSnapshotApplyOptions } from "@/client/api/threads-api";
import { useMeridianAgent } from "@/client/copilot/MeridianCopilotProvider";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { readSwitchedFrame } from "@/client/run-state/run-state-slice";
import { useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import { pendingInboxFromEvent } from "@/features/chat/pending-inbox";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
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
    ...threadSnapshotQueryOptions(threadId, {
      accountSignal,
      accept(snapshot) {
        if (snapshot.thread.id !== threadId || snapshot.thread.userId !== accountId) {
          throw new Error("Thread snapshot identity mismatch");
        }
        if (!actions.acceptsThreadSnapshot(threadId, snapshot.nextSeq)) {
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
    retryDelay: 250,
  });

  const owner = useMemo(() => {
    let mounted = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    let refreshQuery: () => void = () => undefined;
    /** The newest record this owner has seen, to tell a frame whose execution changed. */
    let seen: { version: string; executionId: string | null } | null = null;
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
      /** Note a record taken outside the stream (the accepted snapshot), so a frame is compared with it. */
      noteRecord(runState: { version: string; execution: { executionId: string } | null }) {
        if (seen === null || compareSeq(runState.version, seen.version) > 0)
          seen = {
            version: runState.version,
            executionId: runState.execution?.executionId ?? null,
          };
      },
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
                if (
                  event.type === EventType.RUN_STARTED ||
                  event.type === EventType.RUN_FINISHED ||
                  event.type === EventType.RUN_ERROR
                )
                  refresh(expected);
                if (event.type === EventType.CUSTOM && event.name === "meridian.usage")
                  refresh(expected);
                // Compaction turns have no stream of their own, and a cancelled
                // one ends without RUN_FINISHED. Its execution's end, and the
                // inbox frame after every lease release, revalidate: that is
                // when a divider reserves, settles, or stops.
                if (event.type === EventType.CUSTOM && event.name === EXECUTION_ENDED_EVENT)
                  refresh(expected);
                // Waiting messages that left the chat leave this transcript at the frame's seq.
                if (
                  event.type === EventType.CUSTOM &&
                  event.name === MESSAGES_HANDED_BACK_EVENT &&
                  parseSeq(seq) !== null
                )
                  actions.applyTurnEvent(threadId, event, seq);
                if (event.type === EventType.CUSTOM && event.name === RUN_STATE_EVENT) {
                  const runState = readRunState(event.value);
                  if (runState && parseSeq(seq) !== null) {
                    actions.dispatchRunState(threadId, { type: "record", runState });
                    // A cancelled compaction ends with no RUN_FINISHED, and a divider reserves
                    // or settles with the execution: a record whose execution changed revalidates.
                    const executionId = runState.execution?.executionId ?? null;
                    if (seen !== null && compareSeq(runState.version, seen.version) > 0) {
                      if (seen.executionId !== executionId) refresh(expected);
                    }
                    if (seen === null || compareSeq(runState.version, seen.version) > 0)
                      seen = { version: runState.version, executionId };
                  }
                }
                if (event.type === EventType.CUSTOM && event.name === WRITE_MODE_SWITCHED_EVENT) {
                  const switched = readSwitchedFrame(event.value);
                  if (switched && parseSeq(seq) !== null)
                    actions.dispatchRunState(threadId, { type: "switched", seq, ...switched });
                }
                const pending = pendingInboxFromEvent(event);
                if (pending) {
                  // The chat's owed messages: every tab follows them, not just the sender.
                  controller.observePending(threadId, pending, seq);
                  refresh(expected);
                }
                // A handoff brief holds the chat with no lease or run, so its
                // start and end reach the chat only as a status frame.
                if (event.type === EventType.CUSTOM && event.name === "meridian.thread.status")
                  refresh(expected);
                if (
                  !isDurableBlockEvent(event) ||
                  !isWellFormedDurableBlockEvent(event) ||
                  parseSeq(seq) === null
                )
                  return;
                controller.flushPendingDeltas(threadId);
                if (!current(expected) || !actions.acceptDurableBlockSeq(threadId, seq)) return;
                actions.applyDurableBlockEvent(threadId, event);
              },
              // The `subscribed` state is a whole record, read after catch-up.
              onLiveState: (state) => {
                if (current(expected))
                  actions.dispatchRunState(threadId, {
                    type: "snapshot",
                    runState: state.runState,
                  });
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
  const [appliedThreadId, setAppliedThreadId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!snapshot || accountSignal.aborted) return;
    actions.applyThreadSnapshot(
      snapshot.thread,
      snapshot.turns,
      toThreadSnapshotApplyOptions(snapshot),
    );
    actions.dispatchRunState(threadId, {
      type: "snapshot",
      runState: snapshot.liveState.runState,
    });
    owner.noteRecord(snapshot.liveState.runState);
    controller.observeSnapshot(threadId, snapshot);
    setAppliedThreadId(snapshot.thread.id);
  }, [accountSignal, actions, controller, owner, snapshot, threadId]);

  return {
    snapshot,
    thread: snapshot?.thread ?? null,
    liveState: snapshot?.liveState ?? null,
    actionRequired: snapshot?.actionRequired ?? null,
    nextSeq: snapshot?.nextSeq ?? null,
    settled: appliedThreadId === threadId || isError,
    isError,
    isFetching,
    refetch: () => {
      if (!accountSignal.aborted) void refetch();
    },
    activateProjection: owner.activate,
  };
}
