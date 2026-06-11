import type { AGUIEvent } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { createOrchestratorEventProjector } from "./event-projector.js";
import type { EventJournalReader, EventJournalWriter } from "./index.js";

const HOT_CACHE_LIMIT = 500;
const JOURNAL_REPLAY_LIMIT = 10_000;
const JOURNAL_REPLAY_CONTEXT_LIMIT = 10_000;
const JOURNAL_REPLAY_CONTEXT_ROWS = BigInt(JOURNAL_REPLAY_CONTEXT_LIMIT);
// Public WS cursors are AG-UI event seqs, not journal seqs. One durable journal
// row may project to multiple AG-UI frames, so the frame index is encoded here.
const EVENT_SEQ_FACTOR = 1_000n;
const EVENT_SEQ_CURSOR_OFFSET = EVENT_SEQ_FACTOR - 1n;

type SequencedEventInternal = {
  seq: bigint;
  event: AGUIEvent;
};

type ThreadHubState = {
  events: SequencedEventInternal[];
  projector: ReturnType<typeof createOrchestratorEventProjector>;
  listeners: Set<(event: SequencedEventInternal) => void>;
};

export type { SequencedEventInternal };

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

function toSequencedEvents(journalSeq: bigint, events: AGUIEvent[]): SequencedEventInternal[] {
  return events.map((event, index) => ({
    seq: eventSeqForJournalEvent(journalSeq, index),
    event,
  }));
}

export function createThreadEventHub(deps: {
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
}) {
  const threads = new Map<string, ThreadHubState>();
  const projectors = new Map<string, ReturnType<typeof createOrchestratorEventProjector>>();

  function getState(threadId: string): ThreadHubState {
    let state = threads.get(threadId);
    if (!state) {
      const projector = projectors.get(threadId) ?? createOrchestratorEventProjector();
      projectors.set(threadId, projector);
      state = { events: [], projector, listeners: new Set() };
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

  async function replayFromJournal(
    threadId: ThreadId,
    afterEventSeq: bigint,
  ): Promise<{ events: SequencedEventInternal[]; hitReplayLimit: boolean }> {
    const projector = createOrchestratorEventProjector();
    const afterJournalSeq = journalSeqForEventSeq(afterEventSeq);
    // Replay needs enough prior rows to rebuild the stateful AG-UI projector
    // before filtering by the public event cursor. Starting at the journal row
    // that produced lastSeq can miss the assistant turn.created / earlier delta
    // rows that establish run and open-message state.
    const replayAfterSeq =
      afterJournalSeq > JOURNAL_REPLAY_CONTEXT_ROWS
        ? afterJournalSeq - JOURNAL_REPLAY_CONTEXT_ROWS
        : 0n;
    const contextLimit = Number(afterJournalSeq - replayAfterSeq);
    const readLimit = contextLimit + JOURNAL_REPLAY_LIMIT + 1;
    const entries = await deps.journalReader.readAfter(
      threadId,
      replayAfterSeq.toString(),
      readLimit,
    );
    const hitReplayLimit = entries.length === readLimit;
    const entriesToProject = hitReplayLimit ? entries.slice(0, -1) : entries;
    const replayed: SequencedEventInternal[] = [];

    for (const entry of entriesToProject) {
      replayed.push(
        ...toSequencedEvents(
          BigInt(entry.seq),
          projector.project(entry.payload as OrchestratorEvent),
        ),
      );
    }

    return {
      events: replayed.filter((entry) => entry.seq > afterEventSeq),
      hitReplayLimit,
    };
  }

  async function readCatchup(threadId: ThreadId, afterSeq: bigint) {
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

  function publishPersistedEvent(
    threadId: ThreadId,
    journalSeq: bigint,
    orchestratorEvent: OrchestratorEvent,
  ): void {
    const state = getState(threadId);
    const events = toSequencedEvents(journalSeq, state.projector.project(orchestratorEvent));
    cacheHot(state, events);
    for (const event of events) {
      for (const listener of state.listeners) listener(event);
    }
  }

  return {
    publishPersistedEvent,

    async appendEvent(threadId: ThreadId, orchestratorEvent: OrchestratorEvent): Promise<bigint> {
      const journalSeq = await deps.journalWriter.appendEvent(threadId, orchestratorEvent);
      publishPersistedEvent(threadId, journalSeq, orchestratorEvent);
      return journalSeq;
    },

    async catchup(threadId: ThreadId, afterSeq: bigint = 0n): Promise<SequencedEventInternal[]> {
      const { events } = await readCatchup(threadId, afterSeq);
      return events;
    },

    subscribe(threadId: ThreadId, listener: (event: SequencedEventInternal) => void): () => void {
      const state = getState(threadId);
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },

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
      const guardListener = (entry: SequencedEventInternal) => bufferedLive.push(entry);
      state.listeners.add(guardListener);

      const { events: catchupEvents, hitReplayLimit } = await readCatchup(threadId, afterSeq);

      state.listeners.delete(guardListener);
      state.listeners.add(listener);

      const maxCatchupSeq = catchupEvents.reduce(
        (max, entry) => (entry.seq > max ? entry.seq : max),
        afterSeq,
      );
      const catchupSeqs = new Set(catchupEvents.map((entry) => entry.seq.toString()));
      const tailLive = bufferedLive.filter(
        (entry) =>
          entry.seq > afterSeq &&
          entry.seq > maxCatchupSeq &&
          !catchupSeqs.has(entry.seq.toString()),
      );
      const catchup = [...catchupEvents, ...tailLive].sort((left, right) =>
        left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0,
      );

      return {
        catchup,
        hitReplayLimit,
        unsubscribe: () => state.listeners.delete(listener),
      };
    },

    async headSeq(threadId: ThreadId): Promise<bigint> {
      const state = threads.get(threadId);
      if (state && state.events.length > 0) return state.events[state.events.length - 1]?.seq ?? 0n;
      return cursorSeqForJournalHead(BigInt(await deps.journalReader.headSeq(threadId)));
    },

    journalSeqForEventSeq,
  };
}

export type ThreadEventHub = ReturnType<typeof createThreadEventHub>;
