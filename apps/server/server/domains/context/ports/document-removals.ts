/** Current document removal facts. Callers authorize identities before exposing these records. */
import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { removedFileSentence } from "../document-removal-copy.js";

export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
}

/**
 * A write or read refused because the document was removed under it. It is a not-found to
 * every model path, carrying the record's sentence, until the model gets its own
 * `document_deleted` answer; only a principal that already reached the document sees it.
 */
export class DocumentRemovedError extends DocumentNotFoundError {
  constructor(
    readonly documentId: DocumentId,
    readonly removal: DocumentRemovalRecord,
  ) {
    super(documentId, `Document ${documentId} was ${removal.reason}`, {
      modelReason: removedFileSentence(removal),
    });
    this.name = "DocumentRemovedError";
  }
}
