/** Drizzle EventJournalWriter: append-only SQL writes of orchestrator events with per-thread sequence assignment. Depends inward on the event-journal port; owns the journal append query. */
import type { ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  type DrizzleDb,
} from "../../../../shared/drizzle-transaction.js";
import { deriveJournalTurnId } from "../../domain/journal-turn-id.js";
import type { EventJournalWriter, JournalEventEnvelope } from "../../ports/event-journal.js";

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
