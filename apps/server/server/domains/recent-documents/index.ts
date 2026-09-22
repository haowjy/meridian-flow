/** Barrel: re-exports the recent-documents domain public surface. */
export { createDrizzleRecentDocumentsRepository } from "./adapters/drizzle/recent-documents-repository.js";
export { createInMemoryRecentDocumentsRepository } from "./adapters/in-memory/recent-documents-repository.js";
export {
  type RecentDocumentsRepository,
  RecentDocumentUnavailableError,
  USER_RECENT_DOCUMENTS_CAP,
} from "./ports/recent-documents-repository.js";
