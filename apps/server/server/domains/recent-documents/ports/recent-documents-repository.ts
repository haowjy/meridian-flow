/** Persistence boundary for one account's recently opened documents. */
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";

export const USER_RECENT_DOCUMENTS_CAP = 50;

export interface RecentDocumentsRepository {
  record(userId: UserId, documentId: DocumentId): Promise<void>;
  listByUser(userId: UserId, limit?: number): Promise<RecentDocumentItem[]>;
}
