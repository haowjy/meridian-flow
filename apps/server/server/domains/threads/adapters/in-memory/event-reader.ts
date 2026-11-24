import type { EventJournalReader } from "../../ports/event-journal.js";
import type { InMemoryEventJournalWriter } from "./event-writer.js";

export function createInMemoryEventJournalReader(
  writer: InMemoryEventJournalWriter,
): EventJournalReader {
  return writer;
}
