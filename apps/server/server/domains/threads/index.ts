/** Barrel: re-exports the threads domain's public surface — drizzle + in-memory repositories and event journals, the thread event hub, snapshot builder, access gate, and port types. */

export type { DrizzleDatabase } from "../../shared/drizzle-transaction.js";
export { createDrizzleEventJournalReader } from "./adapters/drizzle/event-reader.js";
export { createDrizzleEventJournalWriter } from "./adapters/drizzle/event-writer.js";
export {
  createInMemoryEventJournalReader,
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "./adapters/in-memory/index.js";
export {
  type ActiveDocumentResolver,
  createActiveDocumentResolver,
} from "./domain/active-document-resolver.js";
export {
  createOrchestratorEventProjector,
  projectOrchestratorEvents,
} from "./domain/orchestrator-event-projector.js";
export { projectReadModelEvent } from "./domain/read-model-projector.js";
export * from "./ports/index.js";
export { createThreadRuntimeService, type ThreadRuntimeService } from "./runtime-service.js";
export { requireThreadOwner } from "./thread-access.js";
export {
  createThreadEventHub,
  type SequencedEventInternal,
  type ThreadEventHub,
} from "./thread-event-hub.js";
export { buildThreadSnapshot } from "./thread-snapshot.js";
