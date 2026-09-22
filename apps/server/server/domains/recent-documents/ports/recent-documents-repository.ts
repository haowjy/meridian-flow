/** Persistence boundary for one account's recently opened documents. */
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";

export const USER_RECENT_DOCUMENTS_CAP = 50;

/** Missing, soft-deleted, or not visible to this user. One outcome, so the route cannot leak existence. */
export class RecentDocumentUnavailableError extends Error {
  constructor(readonly documentId: DocumentId) {
    super("Document not found");
    this.name = "RecentDocumentUnavailableError";
  }
}

export interface RecentDocumentsRepository {
  /** Throws RecentDocumentUnavailableError when the document is missing, deleted, or not visible. */
  record(userId: UserId, documentId: DocumentId): Promise<void>;
  /** Newest first, capped at {@link USER_RECENT_DOCUMENTS_CAP}. */
  listByUser(userId: UserId): Promise<RecentDocumentItem[]>;
}
