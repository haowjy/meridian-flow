/** Atomic ownership of tracked-document identity, Yjs authority and arrival. */

import type { DocumentId } from "@meridian/contracts/runtime";

export type ImmediateDocumentCreation<T> = {
  /** Claims the identity: an inserted row, or a revealed one at the path. Null when taken. */
  persistIdentity(): Promise<DocumentId | null>;
  initializeContent(documentId: DocumentId): Promise<T>;
};

/** The same, for a tree of documents created together (a Copy), all or none. */
export type BulkDocumentCreation<T> = {
  /** Claims every identity as inserted rows. Null when a name or id is taken. */
  persistIdentities(): Promise<readonly DocumentId[] | null>;
  initializeContent(documentIds: readonly DocumentId[]): Promise<T>;
};

export type DocumentCreationAggregate = {
  createDocumentAtomically<T>(
    input: ImmediateDocumentCreation<T>,
  ): Promise<{ created: true; value: T } | { created: false }>;
  createDocumentsAtomically<T>(
    input: BulkDocumentCreation<T>,
  ): Promise<{ created: true; value: T } | { created: false }>;
};

export function createDocumentCreationAggregate(input: {
  atomic<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Arrival hook (contract §9.3), inside `atomic` once identity and content exist. The
   * command already holds the documents' namespace key. A branch's create is no arrival:
   * it never comes through here.
   */
  onArrivals?(documentIds: readonly DocumentId[]): Promise<unknown>;
}): DocumentCreationAggregate {
  const createDocumentsAtomically: DocumentCreationAggregate["createDocumentsAtomically"] = (
    creation,
  ) =>
    input.atomic(async () => {
      const documentIds = await creation.persistIdentities();
      if (documentIds === null) return { created: false } as const;
      const value = await creation.initializeContent(documentIds);
      if (documentIds.length > 0) await input.onArrivals?.(documentIds);
      return { created: true, value } as const;
    });

  return {
    createDocumentsAtomically,
    createDocumentAtomically: (creation) =>
      createDocumentsAtomically({
        persistIdentities: async () => {
          const documentId = await creation.persistIdentity();
          return documentId === null ? null : [documentId];
        },
        initializeContent: ([documentId]) => creation.initializeContent(documentId as DocumentId),
      }),
  };
}
