/** Barrel: re-exports the in-memory thread repositories and event-journal reader/writer factories plus their types. */
export { createInMemoryEventJournalReader } from "./event-reader.js";
export type { InMemoryEventJournalWriter, RecordedEvent } from "./event-writer.js";
export { createInMemoryEventJournalWriter } from "./event-writer.js";
export type { InMemoryRepositories } from "./repositories.js";
export { createInMemoryRepositories } from "./repositories.js";
