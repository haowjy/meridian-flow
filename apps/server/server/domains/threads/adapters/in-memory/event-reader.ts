/** In-memory EventJournalReader: thin wrapper that reads back from the in-memory writer (which also implements the reader). For tests/local dev; depends inward on the event-journal port. */
import type { EventJournalReader } from "../../ports/event-journal.js";
import type { InMemoryEventJournalWriter } from "./event-writer.js";

export function createInMemoryEventJournalReader(
  writer: InMemoryEventJournalWriter,
): EventJournalReader {
  return writer;
}
