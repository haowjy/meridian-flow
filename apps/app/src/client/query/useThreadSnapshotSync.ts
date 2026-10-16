/**
 * useThreadSnapshotSync — the chat's one mounted subscriber and its authoritative history.
 *
 * It owns the thread's single transport subscription for its mounted lifetime and is the chat's
 * one run-state feed: the accepted snapshot, the `subscribed` state and every
 * `meridian.run_state` frame go into the chat's run-state slice as whole records, and the
 * `write_mode.switched` frame answers its intent there. Every other stream event is applied to
 * the transcript store by the turn it names, with append-only deltas coalesced per frame.
 * The stream carries a record but not another client's user turn, so a record that names a
 * waiting writer message the transcript lacks revalidates once (debounced with the other refreshes).
 * Durable block events and hand-backs apply at their own seq. After a snapshot that shows work
 * in progress, the subscription rewinds to the snapshot's cursor, so the reply it joins
 * streams from where the snapshot ends.
 */
import {
  compareSeq,
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  parseSeq,
  RUN_STATE_EVENT,
  readRunState,
  readWriteModeSwitched,
  TURNS_FORGOTTEN_EVENT,
  WRITE_MODE_SWITCHED_EVENT,
} from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import {
  INITIAL_RUN_STATE_VIEW,
  isBusy,
  isDurableBlockEvent,
  isWellFormedDurableBlockEvent,
  receiveRecord,
  unheldWriterMessages,
} from "@meridian/thread-client";
import { StreamDeltaCoalescer } from "@meridian/thread-client/sync";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useState } from "react";
import { toThreadSnapshotApplyOptions } from "@/client/api/threads-api";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { announceError, useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
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
};

/** Whether a record shows the chat working or owing a reply: the snapshot is worth joining the stream for. */
function worksIn(runState: RunState): boolean {
  return isBusy(receiveRecord(INITIAL_RUN_STATE_VIEW, runState));
}

/** Pending creation gates HTTP and automatic subscription through first-send admission. */
export function useThreadSnapshotSync(threadId: string): ThreadSnapshotSyncStatus {
  const actions = useThreadActions();
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
    /** Whether the first accepted snapshot has been taken: only it may rewind the stream. */
    let joined = false;
    const current = (expected: number) =>
      mounted && !accountSignal.aborted && generation === expected;
    /** A pending refresh that must run whatever the transcript holds. */
    let unconditional = false;
    /**
     * Whether the transcript lacks a turn the stream named. The stream carries the record but not
     * another client's user turn, and a `switched` frame names the turn its switch follows, which
     * may be that turn: with the anchor missing, the divider is held out of the transcript and
     * only a snapshot brings both. The store says which dividers still wait; a covering
     * snapshot releases one whether or not the turn came. Asked when the timer fires, so this
     * device's own message, acknowledged meanwhile, is no gap.
     */
    const hasGap = () => {
      if (actions.dividersAwaitingAnchor(threadId).length > 0) return true;
      const held = new Set((actions.turns(threadId) ?? []).map((turn) => turn.id));
      const record = actions.runState(threadId).record;
      return !!record && unheldWriterMessages(record, (id) => held.has(id)).length > 0;
    };
    const refresh = (expected: number, onlyIfGap = false) => {
      if (!current(expected)) return;
      if (!onlyIfGap) unconditional = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const run = unconditional || hasGap();
        unconditional = false;
        if (current(expected) && run) refreshQuery();
      }, 250);
    };
    // One frame boundary for the stream: append-only deltas coalesce into a single store
    // update, and everything else flushes first.
    const coalescer = new StreamDeltaCoalescer((event) => {
      if (mounted && !accountSignal.aborted) actions.applyTurnEvent(threadId, event);
    });
    const flush = () => {
      if (!accountSignal.aborted) coalescer.flush();
    };
    const noteRecord = (runState: RunState): boolean => {
      const newer = seen === null || compareSeq(runState.version, seen.version) > 0;
      const executionId = runState.execution?.executionId ?? null;
      const changed = newer && seen !== null && seen.executionId !== executionId;
      if (newer) seen = { version: runState.version, executionId };
      return changed;
    };
    const subscribe = (expected: number, after?: string): (() => void) =>
      transport.subscribe(
        threadId,
        {
          onEvent: ({ event, error, seq, sourceThreadId }) => {
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
            if (event.type === EventType.CUSTOM && event.name === RUN_STATE_EVENT) {
              const runState = readRunState(event.value);
              if (runState && parseSeq(seq) !== null) {
                actions.dispatchRunState(threadId, { type: "record", runState });
                // A cancelled compaction ends with no RUN_FINISHED, and a divider reserves or
                // settles with the execution: a record whose execution changed revalidates.
                if (noteRecord(runState)) refresh(expected);
                // Another client's waiting message: its turn is not on the stream.
                else refresh(expected, true);
              }
              return;
            }
            if (event.type === EventType.CUSTOM && event.name === WRITE_MODE_SWITCHED_EVENT) {
              const switched = readWriteModeSwitched(event.value);
              if (switched && parseSeq(seq) !== null) {
                // The divider turn is the transcript's, whatever the record says; the same
                // frame answers the writer's control in the run-state slice.
                flush();
                actions.applyTurnEvent(threadId, event, seq);
                actions.dispatchRunState(threadId, { type: "switched", seq, ...switched });
                // The turn it follows is not in the transcript: the gap check asks for a snapshot.
                if (actions.dividersAwaitingAnchor(threadId).length > 0) refresh(expected, true);
              }
              return;
            }
            // Waiting messages that left the chat leave this transcript at the frame's seq.
            if (event.type === EventType.CUSTOM && event.name === MESSAGES_HANDED_BACK_EVENT) {
              flush();
              if (parseSeq(seq) !== null) actions.applyTurnEvent(threadId, event, seq);
              return;
            }
            // Failed turns the chat left behind are stamped wherever they are held.
            if (event.type === EventType.CUSTOM && event.name === TURNS_FORGOTTEN_EVENT) {
              flush();
              actions.applyTurnEvent(threadId, event, seq);
              return;
            }
            // A handoff brief holds the chat with no lease or run, so its start and end reach
            // the chat only as a status frame.
            if (event.type === EventType.CUSTOM && event.name === "meridian.thread.status")
              refresh(expected);
            if (isDurableBlockEvent(event)) {
              if (!isWellFormedDurableBlockEvent(event) || parseSeq(seq) === null) return;
              flush();
              if (!current(expected) || !actions.acceptDurableBlockSeq(threadId, seq)) return;
              actions.applyDurableBlockEvent(threadId, event);
              return;
            }
            // The stream: every other event belongs to the turn it names, or to the one
            // streaming, which the reducer resolves for events that name none.
            const effective =
              event.type === EventType.RUN_ERROR && error
                ? { ...event, message: error.message }
                : event;
            if ("runId" in effective && typeof effective.runId === "string")
              actions.ensureAssistantTurn(threadId, effective.runId);
            coalescer.push(effective);
          },
          // The `subscribed` state is a whole record, read after catch-up.
          onLiveState: (state) => {
            if (!current(expected)) return;
            actions.dispatchRunState(threadId, { type: "snapshot", runState: state.runState });
            noteRecord(state.runState);
            refresh(expected, true);
          },
          onError: (failure) => {
            if (!current(expected)) return;
            flush();
            announceError(failure.message || "Thread stream failed");
          },
          onGap: () => {
            flush();
            refresh(expected);
          },
        },
        after === undefined ? undefined : { after },
      );
    return {
      /**
       * Take the accepted snapshot's record. The first one, if it shows work in progress, joins
       * the stream from its cursor: this subscription began at mount, so the reply it comes to
       * has deltas between the snapshot's read and the subscription that only replay brings. A
       * later snapshot never rewinds: the live stream has applied what it shows.
       */
      takeSnapshot(runState: RunState, resumeAfterSeq: string) {
        noteRecord(runState);
        if (joined) return;
        joined = true;
        if (!worksIn(runState) || !mounted || accountSignal.aborted || !unsubscribe) return;
        flush();
        unsubscribe();
        unsubscribe = subscribe(generation, resumeAfterSeq);
      },
      setRefetch(next: () => void) {
        refreshQuery = next;
      },
      mount() {
        mounted = true;
      },
      activate(): boolean {
        if (!mounted || accountSignal.aborted) return false;
        if (unsubscribe) return true;
        const expected = generation;
        let acquired: (() => void) | null = null;
        try {
          acquired = subscribe(expected);
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
        flush();
        mounted = false;
        generation += 1;
        if (timer) clearTimeout(timer);
        timer = null;
        unsubscribe?.();
        unsubscribe = null;
      },
    };
  }, [accountSignal, actions, threadId, transport]);
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
      type: "history",
      runState: snapshot.liveState.runState,
    });
    owner.takeSnapshot(snapshot.liveState.runState, snapshot.liveState.resumeAfterSeq);
    setAppliedThreadId(snapshot.thread.id);
  }, [accountSignal, actions, owner, snapshot, threadId]);

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
  };
}
