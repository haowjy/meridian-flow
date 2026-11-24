import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import {
  type RecentDocumentsRepository,
  USER_RECENT_DOCUMENTS_CAP,
  USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS,
} from "../../ports/recent-documents-repository.js";

function rowKey(userId: UserId, documentId: DocumentId): string {
  return `${userId}\u0000${documentId}`;
}

export function createInMemoryRecentDocumentsRepository(): RecentDocumentsRepository {
  const rows = new Map<string, { userId: UserId; documentId: DocumentId; openedAt: Date }>();
  return {
    async record(userId, documentId) {
      const key = rowKey(userId, documentId);
      const now = Date.now();
      const existing = rows.get(key);
      if (existing && now - existing.openedAt.getTime() < USER_RECENT_DOCUMENTS_TOUCH_INTERVAL_MS) {
        return false;
      }
      rows.set(key, { userId, documentId, openedAt: new Date(now) });
      const forUser = [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
      for (const row of forUser.slice(USER_RECENT_DOCUMENTS_CAP)) {
        rows.delete(rowKey(row.userId, row.documentId));
      }
      return true;
    },
    async listForProject() {
      return [];
    },
  };
}
