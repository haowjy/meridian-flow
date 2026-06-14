// @ts-nocheck
/** Barrel: re-exports the drizzle thread repositories and event-journal reader/writer factories plus the DrizzleDatabase type. */
export { createDrizzleEventJournalReader } from "./event-reader.js";
export { createDrizzleEventJournalWriter } from "./event-writer.js";
export type { DrizzleDatabase } from "./repositories.js";
export { createDrizzleRepositories } from "./repositories.js";
