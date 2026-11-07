/** Drizzle EventJournalWriter: append-only SQL writes of orchestrator events with per-thread sequence assignment. Depends inward on the event-journal port; owns the journal append query. */
import type { ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  type DrizzleDb,
} from "../../../../shared/drizzle-transaction.js";
import { deriveJournalTurnId } from "../../domain/journal-turn-id.js";
import {
  type EventJournalWriter,
  JOURNAL_ONLY_EVENT_TYPES,
  type JournalEventEnvelope,
  REPLY_FINISHED_EVENT_TYPES,
} from "../../ports/event-journal.js";

async function pruneFinishedReplyTransportRows(
  db: DrizzleDb,
  threadId: ThreadId,
  firstFinishedSeq: bigint,
): Promise<void> {
  const [previousFinished] = await db
    .select({ seq: schema.eventJournal.seq })
    .from(schema.eventJournal)
    .where(
      and(
        eq(schema.eventJournal.threadId, threadId),
        lt(schema.eventJournal.seq, firstFinishedSeq),
        inArray(schema.eventJournal.eventType, [...REPLY_FINISHED_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(schema.eventJournal.seq))
    .limit(1);
  if (!previousFinished) return;

  await db
    .delete(schema.eventJournal)
    .where(
      and(
        eq(schema.eventJournal.threadId, threadId),
        lt(schema.eventJournal.seq, previousFinished.seq),
        inArray(schema.eventJournal.eventType, [...JOURNAL_ONLY_EVENT_TYPES]),
      ),
    );
}

async function appendJournalEvents(
  db: DrizzleDb,
  threadId: ThreadId,
  events: readonly JournalEventEnvelope[],
) {
  if (events.length === 0) throw new Error("Cannot append an empty journal batch");
  const [updated] = await db
    .update(schema.threads)
    .set({ nextSeq: sql`${schema.threads.nextSeq} + ${events.length}` })
    .where(eq(schema.threads.id, threadId))
    .returning({ nextSeq: schema.threads.nextSeq });

  if (!updated) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const lastSeq = updated.nextSeq;
  const firstSeq = lastSeq - BigInt(events.length) + 1n;

  await db.insert(schema.eventJournal).values(
    events.map((event, index) => ({
      threadId,
      turnId: deriveJournalTurnId(event),
      seq: firstSeq + BigInt(index),
      eventType: event.type,
      payload: event,
    })),
  );

  const firstFinishedIndex = events.findIndex((event) =>
    REPLY_FINISHED_EVENT_TYPES.includes(event.type as (typeof REPLY_FINISHED_EVENT_TYPES)[number]),
  );
  if (firstFinishedIndex !== -1) {
    await pruneFinishedReplyTransportRows(db, threadId, firstSeq + BigInt(firstFinishedIndex));
  }

  await db.execute(sql`SELECT pg_notify('thread_events', ${`${threadId}:${lastSeq.toString()}`})`);

  return lastSeq;
}

export function createDrizzleEventJournalWriter(db: DrizzleDatabase): EventJournalWriter {
  return {
    async appendEvents(threadId: ThreadId, events: readonly JournalEventEnvelope[]) {
      const activeDb = currentDrizzleDb(db);
      if (activeDb !== db) {
        return appendJournalEvents(activeDb, threadId, events);
      }
      return db.transaction(async (tx) => appendJournalEvents(tx, threadId, events));
    },
    async appendEvent(threadId: ThreadId, event: JournalEventEnvelope) {
      return this.appendEvents(threadId, [event]);
    },
  };
}
