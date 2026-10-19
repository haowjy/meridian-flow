/** Current document removal facts. Callers authorize identities before exposing these records. */
import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
}

export class DocumentRemovedError extends Error {
  constructor(
    readonly documentId: DocumentId,
    readonly removal: DocumentRemovalRecord,
  ) {
    super(`Document ${documentId} was ${removal.reason}`);
    this.name = "DocumentRemovedError";
  }
}
