/** Atomic ownership of tracked-document identity, Yjs authority and arrival. */

import type { DocumentId } from "@meridian/contracts/runtime";

export type ImmediateDocumentCreation<T> = {
  /** Claims the identity: an inserted row, or a revealed one at the path. Null when taken. */
  persistIdentity(): Promise<DocumentId | null>;
  initializeContent(documentId: DocumentId): Promise<T>;
};

export type DocumentCreationAggregate = {
  createDocumentAtomically<T>(
    input: ImmediateDocumentCreation<T>,
  ): Promise<{ created: true; value: T } | { created: false }>;
  ensureDocument(documentId: string): Promise<void>;
};

export function createDocumentCreationAggregate(input: {
  atomic<T>(operation: () => Promise<T>): Promise<T>;
  ensureDocument(documentId: string): Promise<void>;
  /**
   * Arrival hook (contract §9.3), inside `atomic` once identity and content exist. The
   * command already holds the document's namespace key. A draft's create is no arrival:
   * it never comes through here.
   */
  onArrival?(documentId: DocumentId): Promise<unknown>;
}): DocumentCreationAggregate {
  return {
    async createDocumentAtomically<T>(creation: ImmediateDocumentCreation<T>) {
      return input.atomic(async () => {
        const documentId = await creation.persistIdentity();
        if (documentId === null) return { created: false } as const;
        const value = await creation.initializeContent(documentId);
        await input.onArrival?.(documentId);
        return { created: true, value } as const;
      });
    },

    async ensureDocument(documentId) {
      await input.ensureDocument(documentId);
    },
  };
}
