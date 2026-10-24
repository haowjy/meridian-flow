/** The Drizzle journal writer with an explicit no-op failure recorder, for tests that don't observe failure records. */
import type { Database } from "@meridian/database";
import { createDrizzleEventJournalWriter } from "../domains/threads/adapters/drizzle/event-writer.js";
import { type LiveEventWriter, noFailureRecorder } from "../domains/threads/ports/event-journal.js";

export function createQuietDrizzleJournalWriter(db: Database): LiveEventWriter {
  return { ...createDrizzleEventJournalWriter(db), ...noFailureRecorder };
}
