// @ts-nocheck
/** Drizzle EventJournalReader: SQL replay of persisted orchestrator events for a thread (range/cursor reads). Depends inward on the event-journal port; owns the journal read queries. */
import type { ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, asc, desc, eq, gt, gte, lte, notInArray, sql } from "drizzle-orm";
import type { DrizzleDatabase } from "../../../../shared/drizzle-transaction.js";
import { toIsoString } from "../../domain/contract-serialization.js";
import { deriveJournalTurnId } from "../../domain/journal-turn-id.js";
import type {
  EventJournalReader,
  JournalEntry,
  JournalEventEnvelope,
} from "../../ports/event-journal.js";
import { JOURNAL_ONLY_EVENT_TYPES } from "../../ports/event-journal.js";

const DEFAULT_READ_LIMIT = 1_000;

function mapJournalEntry(row: typeof schema.eventJournal.$inferSelect): JournalEntry {
  const payload = row.payload as JournalEventEnvelope;
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: deriveJournalTurnId(payload),
    seq: row.seq,
    eventType: payload.type,
    payload,
    createdAt: toIsoString(row.createdAt),
  };
}

export function createDrizzleEventJournalReader(db: DrizzleDatabase): EventJournalReader {
  return {
    async readAfter(threadId: ThreadId, afterSeq: bigint, limit = DEFAULT_READ_LIMIT) {
      const rows = await db
        .select()
        .from(schema.eventJournal)
        .where(
          and(eq(schema.eventJournal.threadId, threadId), gt(schema.eventJournal.seq, afterSeq)),
        )
        .orderBy(asc(schema.eventJournal.seq))
        .limit(limit);

      return rows.map(mapJournalEntry);
    },

    async headSeq(threadId: ThreadId) {
      const [row] = await db
        .select({ nextSeq: schema.threads.nextSeq })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId))
        .limit(1);

      return row?.nextSeq ?? 0n;
    },

    async readModelProjectionWatermark(threadId: ThreadId) {
      const [row] = await db
        .select({ seq: schema.eventJournal.seq })
        .from(schema.eventJournal)
        .where(
          and(
            eq(schema.eventJournal.threadId, threadId),
            notInArray(sql<string>`${schema.eventJournal.payload}->>'type'`, [
              ...JOURNAL_ONLY_EVENT_TYPES,
            ]),
          ),
        )
        .orderBy(desc(schema.eventJournal.seq))
        .limit(1);

      return row?.seq ?? 0n;
    },

    async listByThread(threadId, opts = {}) {
      const query = db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, threadId))
        .orderBy(asc(schema.eventJournal.seq));
      const rows = opts.limit !== undefined ? await query.limit(opts.limit) : await query;
      return rows.map(mapJournalEntry);
    },

    async listByType(threadId, eventType) {
      const rows = await db
        .select()
        .from(schema.eventJournal)
        .where(
          and(
            eq(schema.eventJournal.threadId, threadId),
            sql`${schema.eventJournal.payload}->>'type' = ${eventType}`,
          ),
        )
        .orderBy(asc(schema.eventJournal.seq));
      return rows.map(mapJournalEntry);
    },

    async listSince(threadId, afterId) {
      const [cursor] = await db
        .select({ seq: schema.eventJournal.seq })
        .from(schema.eventJournal)
        .where(and(eq(schema.eventJournal.threadId, threadId), eq(schema.eventJournal.id, afterId)))
        .limit(1);
      if (!cursor) return [];
      const rows = await db
        .select()
        .from(schema.eventJournal)
        .where(
          and(eq(schema.eventJournal.threadId, threadId), gt(schema.eventJournal.seq, cursor.seq)),
        )
        .orderBy(asc(schema.eventJournal.seq));
      return rows.map(mapJournalEntry);
    },

    async listByTimeRange(threadId, from, to) {
      const rows = await db
        .select()
        .from(schema.eventJournal)
        .where(
          and(
            eq(schema.eventJournal.threadId, threadId),
            gte(schema.eventJournal.createdAt, from),
            lte(schema.eventJournal.createdAt, to),
          ),
        )
        .orderBy(asc(schema.eventJournal.seq));
      return rows.map(mapJournalEntry);
    },
  };
}
