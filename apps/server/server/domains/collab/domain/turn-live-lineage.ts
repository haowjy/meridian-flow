/** Server-owned read-model for documents with live mutations in an assistant turn. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";

export type LiveLineageDocument = {
  documentId: DocumentId;
  uri: string;
};

export type TurnLiveLineageDocumentStore = {
  listLiveDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<DocumentId[]>;
};

export type TurnLiveLineageReadModel = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
};

export function createTurnLiveLineageReadModel(deps: {
  store: TurnLiveLineageDocumentStore;
  resolveDocumentUri(documentId: DocumentId): Promise<string | null>;
}): TurnLiveLineageReadModel {
  return {
    async listLiveDocumentsForTurn(threadId, turnId) {
      const documentIds = await deps.store.listLiveDocumentIdsForTurn(threadId, turnId);
      const documents = await Promise.all(
        documentIds.map(async (documentId): Promise<LiveLineageDocument | null> => {
          const uri = await deps.resolveDocumentUri(documentId);
          return uri ? { documentId, uri } : null;
        }),
      );
      return documents.filter((document): document is LiveLineageDocument => document !== null);
    },
  };
}
