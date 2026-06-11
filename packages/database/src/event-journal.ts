import type { ThreadId, TurnId } from "@meridian/contracts";
import type { JournalEventType, JsonValue } from "@meridian/contracts/threads";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "./connection";
import { eventJournal, threads } from "./schema/agent-threads";

export type EventJournalRecord = {
  id: string;
  threadId: ThreadId;
  turnId: TurnId | null;
  seq: string;
  eventType: JournalEventType;
  payload: JsonValue;
  createdAt: Date;
};

export type AppendEventJournalInput = {
  threadId: ThreadId;
  turnId?: TurnId | null;
  eventType: JournalEventType;
  payload: JsonValue;
};

export type DrizzleEventJournal = {
  append(input: AppendEventJournalInput): Promise<string>;
  readAfter(threadId: ThreadId, seq: string): Promise<EventJournalRecord[]>;
  headSeq(threadId: ThreadId): Promise<string>;
};

export function createDrizzleEventJournal(db: Database): DrizzleEventJournal {
  return {
    async append(input) {
      return db.transaction(async (tx) => {
        const [head] = await tx
          .update(threads)
          .set({ nextSeq: sql`${threads.nextSeq} + 1` })
          .where(eq(threads.id, input.threadId))
          .returning({ seq: threads.nextSeq });

        const seq = head?.seq ?? 0n;
        await tx.insert(eventJournal).values({
          threadId: input.threadId,
          turnId: input.turnId ?? null,
          seq,
          eventType: input.eventType,
          payload: input.payload,
        });

        return seq.toString();
      });
    },

    async readAfter(threadId, seq) {
      const rows = await db
        .select()
        .from(eventJournal)
        .where(sql`${eventJournal.threadId} = ${threadId} AND ${eventJournal.seq} > ${BigInt(seq)}`)
        .orderBy(asc(eventJournal.seq));

      return rows.map(toEventJournalRecord);
    },

    async headSeq(threadId) {
      const [head] = await db
        .select({ seq: threads.nextSeq })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1);

      return (head?.seq ?? 0n).toString();
    },
  };
}

function toEventJournalRecord(row: typeof eventJournal.$inferSelect): EventJournalRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    turnId: row.turnId,
    seq: row.seq.toString(),
    eventType: row.eventType as JournalEventType,
    payload: row.payload as JsonValue,
    createdAt: row.createdAt,
  };
}
