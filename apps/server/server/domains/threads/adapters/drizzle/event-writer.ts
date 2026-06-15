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

async function appendJournalEvent(db: DrizzleDb, threadId: ThreadId, event: JournalEventEnvelope) {
  const [updated] = await db
    .update(schema.threads)
    .set({ nextSeq: sql`${schema.threads.nextSeq} + 1` })
    .where(eq(schema.threads.id, threadId))
    .returning({ nextSeq: schema.threads.nextSeq });

  if (!updated) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const nextSeq = updated.nextSeq;

  await db.insert(schema.eventJournal).values({
    threadId,
    turnId: deriveJournalTurnId(event),
    seq: nextSeq,
    eventType: event.type,
    payload: event,
  });

  await db.execute(sql`SELECT pg_notify('thread_events', ${`${threadId}:${nextSeq.toString()}`})`);

  return nextSeq;
}

export function createDrizzleEventJournalWriter(db: DrizzleDatabase): EventJournalWriter {
  return {
    async appendEvent(threadId: ThreadId, event: JournalEventEnvelope) {
      const activeDb = currentDrizzleDb(db);
      if (activeDb !== db) {
        return appendJournalEvent(activeDb, threadId, event);
      }
      return db.transaction(async (tx) => {
        return appendJournalEvent(tx, threadId, event);
      });
    },
  };
}
