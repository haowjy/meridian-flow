/** Ordered event-journal reads shared by DB tests. */
import type { Database } from "@meridian/database";
import { eventJournal } from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";

export function journalEventsByThread(db: Database, threadId: string) {
  return db
    .select()
    .from(eventJournal)
    .where(eq(eventJournal.threadId, threadId))
    .orderBy(asc(eventJournal.seq));
}
