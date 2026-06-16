/** In-memory event journal: append-only array of orchestrator events implementing both writer and reader ports, with per-thread sequencing. For tests/local dev; depends inward on the event-journal port. */
import type { ThreadId } from "@meridian/contracts/runtime";

import { toIsoString } from "../../domain/contract-serialization.js";
import { deriveJournalTurnId } from "../../domain/journal-turn-id.js";
import type {
  EventJournalReader,
  EventJournalWriter,
  JournalEntry,
  JournalEventEnvelope,
} from "../../ports/event-journal.js";
import { JOURNAL_ONLY_EVENT_TYPES as journalOnlyEventTypes } from "../../ports/event-journal.js";

export interface RecordedEvent {
  id: string;
  threadId: ThreadId;
  turnId: string | null;
  seq: bigint;
  event: JournalEventEnvelope;
  createdAt: string;
}

export interface InMemoryEventJournalWriter extends EventJournalWriter, EventJournalReader {
  getEvents(threadId: ThreadId): ReadonlyArray<RecordedEvent>;
  getAllEvents(): ReadonlyArray<RecordedEvent>;
}

export function createInMemoryEventJournalWriter(): InMemoryEventJournalWriter {
  const seqByThread = new Map<string, bigint>();
  const events: RecordedEvent[] = [];
  const journalOnlyEventTypeSet = new Set<string>(journalOnlyEventTypes);

  function toEntry(e: RecordedEvent): JournalEntry {
    return {
      id: e.id,
      threadId: e.threadId,
      turnId: e.turnId,
      seq: e.seq,
      eventType: e.event.type,
      payload: e.event,
      createdAt: e.createdAt,
    };
  }

  return {
    async appendEvent(threadId, event) {
      const key = threadId as string;
      const prev = seqByThread.get(key) ?? 0n;
      const seq = prev + 1n;
      seqByThread.set(key, seq);
      events.push({
        id: crypto.randomUUID(),
        threadId,
        turnId: deriveJournalTurnId(event),
        seq,
        event,
        createdAt: toIsoString(new Date()),
      });
      return seq;
    },
    async readAfter(threadId, afterSeq, limit = Number.POSITIVE_INFINITY): Promise<JournalEntry[]> {
      return events
        .filter((e) => e.threadId === threadId && e.seq > afterSeq)
        .slice(0, limit)
        .map(toEntry);
    },
    async headSeq(threadId) {
      return seqByThread.get(threadId as string) ?? 0n;
    },
    async readModelProjectionWatermark(threadId) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.threadId !== threadId) continue;
        if (!journalOnlyEventTypeSet.has(event.event.type)) return event.seq;
      }
      return 0n;
    },
    async listByThread(threadId, opts = {}) {
      return events
        .filter((e) => e.threadId === threadId)
        .slice(0, opts.limit ?? Number.POSITIVE_INFINITY)
        .map(toEntry);
    },
    async listByType(threadId, eventType) {
      return events
        .filter((e) => e.threadId === threadId && e.event.type === eventType)
        .map(toEntry);
    },
    async listSince(threadId, afterId) {
      const cursorIndex = events.findIndex((e) => e.threadId === threadId && e.id === afterId);
      if (cursorIndex === -1) return [];
      return events
        .slice(cursorIndex + 1)
        .filter((e) => e.threadId === threadId)
        .map(toEntry);
    },
    async listByTimeRange(threadId, from, to) {
      return events
        .filter((e) => e.threadId === threadId && e.createdAt >= from && e.createdAt <= to)
        .map(toEntry);
    },
    getEvents(threadId) {
      return events.filter((e) => e.threadId === threadId);
    },
    getAllEvents() {
      return events;
    },
  };
}
