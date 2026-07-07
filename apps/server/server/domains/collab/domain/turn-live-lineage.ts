/** Server-owned read-model for documents edited by one transcript turn. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { TurnReceiptChip, TurnReceiptStateStore } from "./turn-receipt.js";

export type TurnEditedDocumentScope = "live" | "draft";

export type TurnEditedDocument = {
  documentId: DocumentId;
  uri: string;
  scope: TurnEditedDocumentScope;
};

export type LiveLineageDocument = TurnEditedDocument & { scope: "live" };

export type TurnEditedDocumentId = {
  documentId: DocumentId;
  scope: TurnEditedDocumentScope;
};

export type TurnLiveLineageDocumentStore = {
  listLiveDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<DocumentId[]>;
  listEditedDocumentIdsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocumentId[]>;
};

export type TurnLiveLineageReadModel = {
  listLiveDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<LiveLineageDocument[]>;
  listEditedDocumentsForTurn(threadId: ThreadId, turnId: TurnId): Promise<TurnEditedDocument[]>;
  getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null>;
};

export function createTurnLiveLineageReadModel(deps: {
  store: TurnLiveLineageDocumentStore;
  receiptStore?: TurnReceiptStateStore;
  resolveDocumentUri(documentId: DocumentId): Promise<string | null>;
}): TurnLiveLineageReadModel {
  return {
    async listLiveDocumentsForTurn(threadId, turnId) {
      const documentIds = await deps.store.listLiveDocumentIdsForTurn(threadId, turnId);
      const documents = await resolveDocuments(
        documentIds.map((documentId) => ({ documentId, scope: "live" as const })),
      );
      return documents.filter(
        (document): document is LiveLineageDocument => document.scope === "live",
      );
    },

    async listEditedDocumentsForTurn(threadId, turnId) {
      return resolveDocuments(await deps.store.listEditedDocumentIdsForTurn(threadId, turnId));
    },

    async getTurnReceiptChip(threadId, turnId) {
      return deps.receiptStore?.getTurnReceiptChip(threadId, turnId) ?? null;
    },
  };

  async function resolveDocuments(
    documentIds: readonly TurnEditedDocumentId[],
  ): Promise<TurnEditedDocument[]> {
    const documents = await Promise.all(
      documentIds.map(async (document): Promise<TurnEditedDocument | null> => {
        const uri = await deps.resolveDocumentUri(document.documentId);
        return uri ? { ...document, uri } : null;
      }),
    );
    return documents.filter((document): document is TurnEditedDocument => document !== null);
  }
}
