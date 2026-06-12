// @ts-nocheck
/**
 * Thread event hub: the live fan-out + replay surface for a thread's AG-UI
 * events. Maintains a bounded hot cache, replays from the journal on
 * subscribe/cursor, and projects orchestrator events into AG-UI events for
 * subscribers. Owns the realtime delivery layer over the event journal.
 */
import type { MeridianError } from "@meridian/contracts/interrupt";
import { type AGUIEvent, EventType } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import { createOrchestratorEventProjector } from "./domain/orchestrator-event-projector.js";
import type { EventJournalReader, EventJournalWriter } from "./ports/index.js";

const HOT_CACHE_LIMIT = 500;
const JOURNAL_REPLAY_LIMIT = 10_000;
const DEFAULT_EVICTION_GRACE_MS = 60_000;
/** One journal row may workbench to multiple AG-UI events; sub-index is encoded in seq. */
const EVENT_SEQ_FACTOR = 1_000n;
const EVENT_SEQ_CURSOR_OFFSET = EVENT_SEQ_FACTOR - 1n;

export type SequencedEventInternal = {
  seq: bigint;
  event: AGUIEvent;
  error?: MeridianError;
};

type ThreadHubState = {
  events: SequencedEventInternal[];
  projector: ReturnType<typeof createOrchestratorEventProjector>;
  listeners: Set<(event: SequencedEventInternal) => void>;
};

type ThreadEventHubDeps = {
  journalWriter: EventJournalWriter;
  journalReader: EventJournalReader;
  eventSink: EventSink;
};

export type ThreadEventHubOptions = {
  /** Grace period before evicting hub state after the last listener unsubscribes. */
  evictionGraceMs?: number;
};

export type ThreadEventHub = ReturnType<typeof createThreadEventHub>;

function eventSeqForJournalEvent(journalSeq: bigint, projectedIndex: number): bigint {
  return journalSeq * EVENT_SEQ_FACTOR + BigInt(projectedIndex);
}

function cursorSeqForJournalHead(journalSeq: bigint): bigint {
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

function toSequencedEvents(
  journalSeq: bigint,
  events: AGUIEvent[],
  orchestratorEvent: OrchestratorEvent,
): SequencedEventInternal[] {
  return events.map((event, index) => ({
    seq: eventSeqForJournalEvent(journalSeq, index),
    event,
    error: errorEnvelopeForProjectedEvent(orchestratorEvent, event),
  }));
}

export function createThreadEventHub(
  deps: ThreadEventHubDeps,
  options: ThreadEventHubOptions = {},
) {
  const eventSink = deps.eventSink;
  const threads = new Map<string, ThreadHubState>();
  const projectors = new Map<string, ReturnType<typeof createOrchestratorEventProjector>>();
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
        if (state && state.listeners.size === 0) {
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
      const projector = projectors.get(threadId) ?? createOrchestratorEventProjector();
      projectors.set(threadId, projector);
      state = {
        events: [],
        projector,
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

  async function replayFromJournal(
    threadId: ThreadId,
    afterEventSeq: bigint,
  ): Promise<{ events: SequencedEventInternal[]; hitReplayLimit: boolean }> {
    const projector = createOrchestratorEventProjector();
    const entries = await deps.journalReader.readAfter(threadId, 0n, JOURNAL_REPLAY_LIMIT);
    const replayed: SequencedEventInternal[] = [];

    for (const entry of entries) {
      const aguiEvents = projector.project(entry.payload as OrchestratorEvent);
      replayed.push(
        ...toSequencedEvents(entry.seq, aguiEvents, entry.payload as OrchestratorEvent),
      );
    }

    return {
      events: replayed.filter((entry) => entry.seq > afterEventSeq),
      hitReplayLimit: entries.length === JOURNAL_REPLAY_LIMIT,
    };
  }

  async function readCatchup(
    threadId: ThreadId,
    afterSeq: bigint,
  ): Promise<{ events: SequencedEventInternal[]; hitReplayLimit: boolean }> {
    const state = threads.get(threadId);
    const hotEvents = state?.events ?? [];
    if (hotEvents.length > 0 && afterSeq >= hotEvents[0].seq - 1n) {
      return {
        events: hotEvents.filter((entry) => entry.seq > afterSeq),
        hitReplayLimit: false,
      };
    }

    return replayFromJournal(threadId, afterSeq);
  }

  return {
    async appendEvent(threadId: ThreadId, orchestratorEvent: OrchestratorEvent): Promise<bigint> {
      const journalSeq = await deps.journalWriter.appendEvent(threadId, orchestratorEvent);
      if (orchestratorEvent.type === "turn.error") {
        emitEvent(eventSink, {
          level: "error",
          source: "threads.event-hub",
          name: "turn.error",
          payload: {
            threadId,
            turnId: orchestratorEvent.turn.id,
            error: orchestratorEvent.error,
          },
        });
      }
      const state = getState(threadId);
      const sequencedEvents = toSequencedEvents(
        journalSeq,
        state.projector.project(orchestratorEvent),
        orchestratorEvent,
      );

      cacheHot(state, sequencedEvents);

      for (const sequenced of sequencedEvents) {
        notifyListeners(state, sequenced);
      }

      if (state.listeners.size === 0) {
        scheduleEviction(threadId);
      }

      return journalSeq;
    },

    async catchup(threadId: ThreadId, afterSeq: bigint = 0n): Promise<SequencedEventInternal[]> {
      const { events } = await readCatchup(threadId, afterSeq);
      return events;
    },

    subscribe(threadId: ThreadId, listener: (event: SequencedEventInternal) => void): () => void {
      const state = getState(threadId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
        onListenerRemoved(threadId);
      };
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
      hitReplayLimit: boolean;
      unsubscribe: () => void;
    }> {
      const state = getState(threadId);
      const bufferedLive: SequencedEventInternal[] = [];
      const guardListener = (entry: SequencedEventInternal) => {
        bufferedLive.push(entry);
      };
      state.listeners.add(guardListener);

      const { events: catchupEvents, hitReplayLimit } = await readCatchup(threadId, afterSeq);

      state.listeners.delete(guardListener);
      state.listeners.add(listener);

      const catchupSeqs = new Set(catchupEvents.map((entry) => entry.seq));
      const maxCatchupSeq = catchupEvents.reduce(
        (max, entry) => (entry.seq > max ? entry.seq : max),
        afterSeq,
      );
      const tailLive = bufferedLive.filter(
        (entry) => entry.seq > afterSeq && entry.seq > maxCatchupSeq && !catchupSeqs.has(entry.seq),
      );
      const catchup = [...catchupEvents, ...tailLive].sort((a, b) =>
        a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
      );

      return {
        catchup,
        hitReplayLimit,
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
      const state = threads.get(threadId);
      if (state && state.events.length > 0) {
        return state.events[state.events.length - 1].seq;
      }
      return cursorSeqForJournalHead(await deps.journalReader.headSeq(threadId));
    },

    async readModelProjectionWatermark(threadId: ThreadId): Promise<bigint> {
      return cursorSeqForJournalHead(
        await deps.journalReader.readModelProjectionWatermark(threadId),
      );
    },

    journalSeqForEventSeq,
  };
}
