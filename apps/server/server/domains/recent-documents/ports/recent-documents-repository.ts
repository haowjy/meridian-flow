/** Persistence boundary for one account's recently opened documents. */
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";

export const USER_RECENT_DOCUMENTS_CAP = 50;

/**
 * How close two opens of one document must be to count as the same open. The
 * stored row is the record, so the rule lives with it: a repeat inside the
 * interval leaves `openedAt` alone instead of rewriting it.
 */
export const USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS = 5_000;

/** Missing, soft-deleted, or not visible to this user. One outcome, so the route cannot leak existence. */
export class RecentDocumentUnavailableError extends Error {
  constructor(readonly documentId: DocumentId) {
    super("Document not found");
    this.name = "RecentDocumentUnavailableError";
  }
}

export interface RecentDocumentsRepository {
  /**
   * Records an open. Returns whether the stored recency moved: false when the
   * document was already recorded inside the interval, so no write was needed.
   * Throws RecentDocumentUnavailableError when the document is missing,
   * deleted, or not visible.
   */
  record(userId: UserId, documentId: DocumentId): Promise<boolean>;
  /**
   * One project's slice of the account's history, newest first, capped at
   * {@link USER_RECENT_DOCUMENTS_CAP}. The landing lives inside a project, so
   * the read is scoped to it; the rows themselves stay account-keyed, because
   * what an open records is that this writer touched this document.
   */
  listForProject(projectId: string, userId: UserId): Promise<RecentDocumentItem[]>;
}
