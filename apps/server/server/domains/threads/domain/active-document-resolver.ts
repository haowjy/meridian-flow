/** Canonical resolution of the documents active in a thread and their active threads. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  ThreadDocumentRepository,
  TurnDocumentTouchRepository,
} from "../ports/repositories.js";

export interface ActiveDocumentResolver {
  listDocumentIds(threadId: ThreadId): Promise<string[]>;
  listThreadIds(documentId: string): Promise<ThreadId[]>;
}

export function createActiveDocumentResolver(repositories: {
  threadDocuments: ThreadDocumentRepository;
  documentTouches: TurnDocumentTouchRepository;
}): ActiveDocumentResolver {
  return {
    async listDocumentIds(threadId) {
      const [attachments, touches] = await Promise.all([
        repositories.threadDocuments.listByThread(threadId),
        repositories.documentTouches.listByThread(threadId),
      ]);
      return uniqueSorted([
        ...attachments.map(({ documentId }) => documentId),
        ...touches.map(({ documentId }) => documentId),
      ]);
    },
    async listThreadIds(documentId) {
      const [attachedThreadIds, touchedThreadIds] = await Promise.all([
        repositories.threadDocuments.listThreadIdsByDocument(documentId),
        repositories.documentTouches.listThreadIdsByDocument(documentId),
      ]);
      return uniqueSorted([...attachedThreadIds, ...touchedThreadIds]);
    },
  };
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
