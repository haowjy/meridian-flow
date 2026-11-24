import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";

export const USER_RECENT_DOCUMENTS_CAP = 50;

export const USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS = 5_000;

export class RecentDocumentUnavailableError extends Error {
  constructor(readonly documentId: DocumentId) {
    super("Document not found");
    this.name = "RecentDocumentUnavailableError";
  }
}

export interface RecentDocumentsRepository {
  record(userId: UserId, documentId: DocumentId): Promise<boolean>;
  listForProject(projectId: string, userId: UserId): Promise<RecentDocumentItem[]>;
}
