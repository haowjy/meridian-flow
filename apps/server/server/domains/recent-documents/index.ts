export { createDrizzleRecentDocumentsRepository } from "./adapters/drizzle/recent-documents-repository.js";
export {
  type RecentDocumentsRepository,
  RecentDocumentUnavailableError,
  USER_RECENT_DOCUMENTS_CAP,
} from "./ports/recent-documents-repository.js";
