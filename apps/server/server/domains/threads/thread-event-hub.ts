/**
 * Thread event hub: the live fan-out + replay surface for a thread's AG-UI
 * events. Maintains a bounded hot cache, replays from the journal on
 * `catchupAndSubscribe` or cursor reads, and projects orchestrator events into AG-UI events for
 * subscribers. Owns the realtime delivery layer over the event journal.
 */

import type { MeridianError } from "@meridian/contracts/errors";
import type { FailureRecord } from "@meridian/contracts/failures";
import {
  type AGUIEvent,
  EventType,
  RUN_STATE_EVENT,
  type SequencedEvent,
} from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { recordFailureAfterCommit } from "../../shared/failure-records.js";
import type { InMemoryTransactionOwner } from "../../shared/in-memory-transaction.js";
import {
  type EventSink,
  emitEvent,
  recordFailure,
  unknownToEventPayload,
} from "../observability/index.js";
import {
  createOrchestratorEventProjector,
  PROJECTOR_RESET_EVENT_TYPES,
} from "./domain/orchestrator-event-projector.js";
import type { EventJournalReader, EventJournalWriter } from "./ports/index.js";

const HOT_CACHE_LIMIT = 500;
const JOURNAL_PAGE_SIZE = 1_000;
const DEFAULT_EVICTION_GRACE_MS = 60_000;
/** One journal row may project to multiple AG-UI events; sub-index is encoded in seq. */
const EVENT_SEQ_FACTOR = 1_000n;
const EVENT_SEQ_CURSOR_OFFSET = EVENT_SEQ_FACTOR - 1n;

export type SequencedEventInternal = Omit<SequencedEvent, "seq"> & { seq: bigint };

type ThreadHubState = {
  events: SequencedEventInternal[];
  projector: ReturnType<typeof createOrchestratorEventProjector>;
  journalCursor: bigint;
  initialized: boolean;
  draining: Promise<void> | null;
  drainRequested: boolean;
  listeners: Set<(event: SequencedEventInternal) => void>;
};

type ThreadEventHubDeps = {
  journalWriter: EventJournalWriter;
  journalReader: EventJournalReader;
  eventSink: EventSink;
  scheduleAfterCommit?: (callback: () => void | Promise<void>) => void;
  /** In-memory composition: failure records follow this owner's commit instead of a Drizzle transaction's. */
  inMemoryTransactionOwner?: InMemoryTransactionOwner;
};

export type ThreadEventHubOptions = {
  /** Grace period before evicting hub state after the last listener unsubscribes. */
  evictionGraceMs?: number;
};

export type ThreadEventHub = ReturnType<typeof createThreadEventHub>;

/** The socket seq of a journal row's `projectedIndex`-th frame. */
export function eventSeqForJournalEvent(journalSeq: bigint, projectedIndex: number): bigint {
  return journalSeq * EVENT_SEQ_FACTOR + BigInt(projectedIndex);
}

/** The socket seq of the last frame a journal row can carry; the snapshot's `nextSeq - 1`. */
export function cursorSeqForJournalHead(journalSeq: bigint): bigint {
  if (journalSeq === 0n) return 0n;
  return journalSeq * EVENT_SEQ_FACTOR + EVENT_SEQ_CURSOR_OFFSET;
}

function journalSeqForEventSeq(eventSeq: bigint): bigint {
  return eventSeq / EVENT_SEQ_FACTOR;
}

function errorEnvelopeForProjectedEvent(
  orchestratorEvent: OrchestratorEvent,
  event: AGUIEvent,
): MeridianError | undefined {
  if (orchestratorEvent.type !== "turn.error" || event.type !== EventType.RUN_ERROR) {
    return undefined;
  }
  return orchestratorEvent.error;
}

/** A run-state frame is a whole `RunState` at its own stream seq; live and replayed frames stamp the same value. */
function stampRunStateVersion(event: AGUIEvent, seq: bigint): AGUIEvent {
  if (event.type !== EventType.CUSTOM || event.name !== RUN_STATE_EVENT) return event;
  return { ...event, value: { ...(event.value as object), version: seq.toString() } };
}

function toSequencedEvents(
  journalSeq: bigint,
  events: AGUIEvent[],
  orchestratorEvent: OrchestratorEvent,
): SequencedEventInternal[] {
  return events.map((event, index) => {
    const seq = eventSeqForJournalEvent(journalSeq, index);
    return {
      seq,
      event: stampRunStateVersion(event, seq),
      error: errorEnvelopeForProjectedEvent(orchestratorEvent, event),
    };
  });
}

export function createThreadEventHub(
  deps: ThreadEventHubDeps,
  options: ThreadEventHubOptions = {},
) {
  const eventSink = deps.eventSink;
  const threads = new Map<string, ThreadHubState>();
  const evictionGraceMs = options.evictionGraceMs ?? DEFAULT_EVICTION_GRACE_MS;
  const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelEviction(threadId: string): void {
    const timer = evictionTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    evictionTimers.delete(threadId);
  }

  function scheduleEviction(threadId: string): void {
    cancelEviction(threadId);
    evictionTimers.set(
      threadId,
      setTimeout(() => {
        evictionTimers.delete(threadId);
        const state = threads.get(threadId);
        if (state && state.listeners.size === 0 && state.draining === null) {
          threads.delete(threadId);
        }
      }, evictionGraceMs),
    );
  }

  function onListenerRemoved(threadId: string): void {
    const state = threads.get(threadId);
    if (state && state.listeners.size === 0) {
      scheduleEviction(threadId);
    }
  }

  function getState(threadId: string): ThreadHubState {
    cancelEviction(threadId);
    let state = threads.get(threadId);
    if (!state) {
      state = {
        events: [],
        projector: createOrchestratorEventProjector(),
        journalCursor: 0n,
        initialized: false,
        draining: null,
        drainRequested: false,
        listeners: new Set(),
      };
      threads.set(threadId, state);
    }
    return state;
  }

  function cacheHot(state: ThreadHubState, events: SequencedEventInternal[]): void {
    state.events.push(...events);
    if (state.events.length > HOT_CACHE_LIMIT) {
      state.events.splice(0, state.events.length - HOT_CACHE_LIMIT);
    }
  }

  function notifyListeners(state: ThreadHubState, event: SequencedEventInternal): void {
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch (error) {
        emitEvent(eventSink, {
          level: "error",
          source: "threads.event-hub",
          name: "listener.failed",
          payload: unknownToEventPayload(error),
        });
      }
    }
  }

  async function* readThrough(threadId: ThreadId, after: bigint, through: bigint) {
    let cursor = after;
    while (cursor < through) {
      const entries = await deps.journalReader.readAfter(threadId, cursor, JOURNAL_PAGE_SIZE);
      if (entries.length === 0) return;
      for (const entry of entries) {
        if (entry.seq > through) return;
        yield entry;
        cursor = entry.seq;
      }
    }
  }

  async function replayFromJournal(
    threadId: ThreadId,
    afterEventSeq: bigint,
    throughJournalSeq: bigint,
  ): Promise<SequencedEventInternal[]> {
    const projector = createOrchestratorEventProjector();
    const replayed: SequencedEventInternal[] = [];
    // A cursor can split a multi-frame row. Reconstruct that row from the last reset
    // strictly before it, so both the remaining frames and their sub-indexes stay identical.
    const cursor = await deps.journalReader.lastSeqBefore(
      threadId,
      journalSeqForEventSeq(afterEventSeq),
      PROJECTOR_RESET_EVENT_TYPES,
    );
    for await (const entry of readThrough(threadId, cursor, throughJournalSeq)) {
      const payload = entry.payload as OrchestratorEvent;
      const projected = toSequencedEvents(entry.seq, projector.project(payload), payload);
      replayed.push(...projected.filter((event) => event.seq > afterEventSeq));
    }
    return replayed;
  }

  async function drainCommittedJournal(threadId: ThreadId): Promise<void> {
    const state = threads.get(threadId);
    if (!state) return;
    cancelEviction(threadId);
    if (state.draining) {
      state.drainRequested = true;
      return state.draining;
    }
    state.drainRequested = false;
    state.draining = (async () => {
      const head = await deps.journalReader.headSeq(threadId);
      if (!state.initialized) {
        // Build privately: a failed page must not publish a partial projector. The head and
        // reset belong to the live owner, never to whichever subscriber arrived first.
        const cursor = await deps.journalReader.lastSeqBefore(
          threadId,
          head + 1n,
          PROJECTOR_RESET_EVENT_TYPES,
        );
        const projector = createOrchestratorEventProjector();
        const events: SequencedEventInternal[] = [];
        for await (const entry of readThrough(threadId, cursor, head)) {
          const event = entry.payload as OrchestratorEvent;
          events.push(...toSequencedEvents(entry.seq, projector.project(event), event));
          if (events.length > HOT_CACHE_LIMIT) events.splice(0, events.length - HOT_CACHE_LIMIT);
        }
        state.projector = projector;
        state.events = events;
        state.journalCursor = head;
        state.initialized = true;
        return;
      }
      for await (const entry of readThrough(threadId, state.journalCursor, head)) {
        const event = entry.payload as OrchestratorEvent;
        const projected = toSequencedEvents(entry.seq, state.projector.project(event), event);
        state.journalCursor = entry.seq;
        cacheHot(state, projected);
        for (const sequenced of projected) notifyListeners(state, sequenced);
      }
      state.journalCursor = head;
    })().finally(() => {
      state.draining = null;
      if (state.drainRequested) {
        state.drainRequested = false;
        invalidateCommittedJournal(threadId);
      } else if (state.listeners.size === 0) {
        scheduleEviction(threadId);
      }
    });
    return state.draining;
  }

  function invalidateCommittedJournal(threadId: ThreadId): void {
    void drainCommittedJournal(threadId).catch((error) => {
      emitEvent(eventSink, {
        level: "error",
        source: "threads.event-hub",
        name: "journal.drain.failed",
        payload: unknownToEventPayload(error),
      });
    });
  }

  async function readCatchup(
    threadId: ThreadId,
    afterSeq: bigint,
  ): Promise<SequencedEventInternal[]> {
    const state = threads.get(threadId);
    if (state && afterSeq >= cursorSeqForJournalHead(state.journalCursor)) return [];
    const hotEvents = state?.events ?? [];
    if (hotEvents.length > 0 && afterSeq >= hotEvents[0].seq - 1n) {
      return hotEvents.filter((entry) => entry.seq > afterSeq);
    }

    return replayFromJournal(threadId, afterSeq, state?.journalCursor ?? 0n);
  }

  return {
    invalidateCommittedJournal,
    recordFailure(record: FailureRecord): void {
      recordFailureAfterCommit(
        record,
        (emitted) => recordFailure(eventSink, emitted),
        deps.inMemoryTransactionOwner,
      );
    },
    async appendEvents(
      threadId: ThreadId,
      orchestratorEvents: readonly OrchestratorEvent[],
    ): Promise<bigint> {
      const journalSeq = await deps.journalWriter.appendEvents(threadId, orchestratorEvents);
      const invalidate = () => invalidateCommittedJournal(threadId);
      if (deps.scheduleAfterCommit) deps.scheduleAfterCommit(invalidate);
      else await drainCommittedJournal(threadId);
      return journalSeq;
    },
    async appendEvent(threadId: ThreadId, orchestratorEvent: OrchestratorEvent): Promise<bigint> {
      return this.appendEvents(threadId, [orchestratorEvent]);
    },

    async catchup(threadId: ThreadId, afterSeq: bigint = 0n): Promise<SequencedEventInternal[]> {
      const { catchup, unsubscribe } = await this.catchupAndSubscribe(threadId, afterSeq, () => {});
      unsubscribe();
      return catchup;
    },

    /**
     * Replay backlog while a guard listener buffers any live appendEvent fan-out,
     * then attach the real listener. Buffered events are merged into catchup so
     * nothing is lost between replay completion and subscription.
     */
    async catchupAndSubscribe(
      threadId: ThreadId,
      afterSeq: bigint,
      listener: (event: SequencedEventInternal) => void,
    ): Promise<{
      catchup: SequencedEventInternal[];
      unsubscribe: () => void;
    }> {
      const state = getState(threadId);
      const bufferedLive: SequencedEventInternal[] = [];
      const guardListener = (entry: SequencedEventInternal) => {
        if (entry.seq > afterSeq) bufferedLive.push(entry);
      };
      state.listeners.add(guardListener);

      let catchupEvents: SequencedEventInternal[];
      try {
        await drainCommittedJournal(threadId);
        catchupEvents = await readCatchup(threadId, afterSeq);
      } catch (error) {
        state.listeners.delete(guardListener);
        onListenerRemoved(threadId);
        throw error;
      }
      state.listeners.delete(guardListener);
      state.listeners.add(listener);

      const maxCatchupSeq = catchupEvents.reduce(
        (max, entry) => (entry.seq > max ? entry.seq : max),
        afterSeq,
      );
      const tailLive = bufferedLive.filter((entry) => entry.seq > maxCatchupSeq);
      const catchup = [...catchupEvents, ...tailLive].sort((a, b) =>
        a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
      );

      return {
        catchup,
        unsubscribe: () => {
          state.listeners.delete(listener);
          onListenerRemoved(threadId);
        },
      };
    },

    hasThreadState(threadId: ThreadId): boolean {
      return threads.has(threadId);
    },

    async headSeq(threadId: ThreadId): Promise<bigint> {
      return cursorSeqForJournalHead(await deps.journalReader.headSeq(threadId));
    },

    async readModelProjectionWatermark(threadId: ThreadId): Promise<bigint> {
      return cursorSeqForJournalHead(
        await deps.journalReader.readModelProjectionWatermark(threadId),
      );
    },
  };
}
