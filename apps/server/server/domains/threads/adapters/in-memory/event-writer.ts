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
import {
  JOURNAL_ONLY_EVENT_TYPES as journalOnlyEventTypes,
  REPLY_FINISHED_EVENT_TYPES,
} from "../../ports/event-journal.js";

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
    async appendEvents(threadId, appended) {
      if (appended.length === 0) throw new Error("Cannot append an empty journal batch");
      const key = threadId as string;
      const prev = seqByThread.get(key) ?? 0n;
      const createdAt = toIsoString(new Date());
      for (const [index, event] of appended.entries()) {
        events.push({
          id: crypto.randomUUID(),
          threadId,
          turnId: deriveJournalTurnId(event),
          seq: prev + BigInt(index) + 1n,
          event,
          createdAt,
        });
      }
      const lastSeq = prev + BigInt(appended.length);
      seqByThread.set(key, lastSeq);
      const firstFinishedIndex = appended.findIndex((event) =>
        REPLY_FINISHED_EVENT_TYPES.includes(
          event.type as (typeof REPLY_FINISHED_EVENT_TYPES)[number],
        ),
      );
      if (firstFinishedIndex !== -1) {
        const firstFinishedSeq = prev + BigInt(firstFinishedIndex) + 1n;
        const previousFinished = events
          .filter(
            (event) =>
              event.threadId === threadId &&
              event.seq < firstFinishedSeq &&
              REPLY_FINISHED_EVENT_TYPES.includes(
                event.event.type as (typeof REPLY_FINISHED_EVENT_TYPES)[number],
              ),
          )
          .at(-1);
        if (previousFinished) {
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (
              event &&
              event.threadId === threadId &&
              event.seq < previousFinished.seq &&
              journalOnlyEventTypeSet.has(event.event.type)
            )
              events.splice(index, 1);
          }
        }
      }
      return lastSeq;
    },
    async appendEvent(threadId, event) {
      return this.appendEvents(threadId, [event]);
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
    getEvents(threadId) {
      return events.filter((e) => e.threadId === threadId);
    },
    getAllEvents() {
      return events;
    },
  };
}
