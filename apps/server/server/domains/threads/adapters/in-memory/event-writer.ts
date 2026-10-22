/** In-memory event journal: append-only array of orchestrator events implementing both writer and reader ports, with per-thread sequencing. For tests/local dev; depends inward on the event-journal port. */

import type { FailureRecord } from "@meridian/contracts/failures";
import type { ThreadId } from "@meridian/contracts/runtime";
import { recordFailureAfterCommit } from "../../../../shared/failure-records.js";
import {
  type InMemoryTransactionOwner,
  noTransactionOwner,
} from "../../../../shared/in-memory-transaction.js";
import { toIsoString } from "../../domain/contract-serialization.js";
import { deriveJournalTurnId } from "../../domain/journal-turn-id.js";
import type {
  EventJournalReader,
  JournalEntry,
  JournalEventEnvelope,
  LiveEventWriter,
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

export interface InMemoryEventJournalWriter extends LiveEventWriter, EventJournalReader {
  /** Failure records emitted so far, after the outermost in-memory commit. */
  getFailureRecords(): ReadonlyArray<FailureRecord>;
  getEvents(threadId: ThreadId): ReadonlyArray<RecordedEvent>;
  getAllEvents(): ReadonlyArray<RecordedEvent>;
}

/**
 * `owner` is the transaction owner of the repositories the journal serves; records follow its commit.
 * It is required: a fixture with no transactions passes `noTransactionOwner`.
 */
export function createInMemoryEventJournalWriter(
  owner: InMemoryTransactionOwner | typeof noTransactionOwner,
): InMemoryEventJournalWriter {
  const seqByThread = new Map<string, bigint>();
  const events: RecordedEvent[] = [];
  const failures: FailureRecord[] = [];
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
    recordFailure(record) {
      recordFailureAfterCommit(
        record,
        (emitted) => failures.push(emitted),
        owner === noTransactionOwner ? undefined : owner,
      );
    },
    getFailureRecords: () => failures,
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
    async lastSeqBefore(threadId, beforeSeq, eventTypes) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (
          entry &&
          entry.threadId === threadId &&
          entry.seq < beforeSeq &&
          eventTypes.includes(entry.event.type)
        )
          return entry.seq;
      }
      return 0n;
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
