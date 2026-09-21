/** Map-backed recents stub. No catalog, so record does not owner-gate and list returns []. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import {
  type RecentDocumentsRepository,
  USER_RECENT_DOCUMENTS_CAP,
} from "../../ports/recent-documents-repository.js";

function rowKey(userId: UserId, documentId: DocumentId): string {
  return `${userId}\u0000${documentId}`;
}

export function createInMemoryRecentDocumentsRepository(): RecentDocumentsRepository {
  const rows = new Map<string, { userId: UserId; documentId: DocumentId; openedAt: Date }>();
  return {
    async record(userId, documentId) {
      rows.set(rowKey(userId, documentId), { userId, documentId, openedAt: new Date() });
      const forUser = [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
      for (const row of forUser.slice(USER_RECENT_DOCUMENTS_CAP)) {
        rows.delete(rowKey(row.userId, row.documentId));
      }
    },
    async listByUser() {
      return [];
    },
  };
}
