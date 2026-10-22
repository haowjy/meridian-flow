/** Server-owned read-model for documents edited by one transcript turn. */

import type { TurnReceiptChip } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { FileDestination } from "../../file-policy/index.js";
import type { TurnReceiptStateStore } from "./turn-receipt.js";

export type TurnEditedDocumentScope = "live" | "draft";

/**
 * Where a turn's edit landed: live, or the draft of the Work whose branch held it (from the
 * edit's draft row). A draft-scoped edit is read and reversed at that draft destination, so
 * it stays on the turn's receipt after a live delete its draft outlived (D79).
 */
export type TurnEditedDocumentId =
  | { documentId: DocumentId; scope: "live" }
  | { documentId: DocumentId; scope: "draft"; work: { id: WorkId; handle: string | null } };

export type TurnEditedDocument = TurnEditedDocumentId & { uri: string };

export type LiveLineageDocument = TurnEditedDocument & { scope: "live" };

/** The file-policy destination a turn's edit is read and reversed at. */
export function turnEditDestination(target: TurnEditedDocumentId): FileDestination {
  return target.scope === "draft"
    ? { kind: "draft", workId: target.work.id, workHandle: target.work.handle }
    : { kind: "live" };
}

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
  /** The address a document holds or was deleted at: a surviving draft's location. */
  resolveLastDocumentUri(documentId: DocumentId): Promise<string | null>;
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
        const uri =
          document.scope === "draft"
            ? await deps.resolveLastDocumentUri(document.documentId)
            : await deps.resolveDocumentUri(document.documentId);
        return uri ? { ...document, uri } : null;
      }),
    );
    return documents.filter((document): document is TurnEditedDocument => document !== null);
  }
}
