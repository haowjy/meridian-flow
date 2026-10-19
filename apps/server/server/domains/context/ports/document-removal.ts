/**
 * Document removal: the tree-owned kernel, the collab half it calls, the record reader domain
 * code depends on, and the refusal a removed document raises. Callers of `remove` hold
 * Work/namespace and sorted document mutation locks before entering it.
 */
import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { DocumentId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentRemovalCause, DocumentRemovalRecord } from "@meridian/contracts/protocol";

type RemoveDocumentsInput = {
  documentIds: readonly DocumentId[];
  reason: "deleted" | "discarded";
  userId?: UserId;
  /** A Work cascade: the Work whose deletion removes these, so its Restore brings them back. */
  workId?: WorkId;
  cause?: DocumentRemovalCause;
  at?: Date;
};

export interface DocumentRemoval {
  /** Tombstones the living ones among `documentIds` and returns exactly those. */
  remove(input: RemoveDocumentsInput): Promise<readonly DocumentId[]>;
}

/**
 * Collab's half: close every active draft on the removed documents, retiring them after commit,
 * and name the Works those drafts belonged to (their pending counts moved).
 */
export interface DocumentRemovalCollab {
  closeRemovedDocuments(
    documentIds: readonly DocumentId[],
    record: DocumentRemovalRecord,
  ): Promise<readonly WorkId[]>;
}

/** Current removal records, in the caller's transaction. Callers authorize identities before exposing them. */
export interface DocumentRemovals {
  lookup(
    documentIds: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>>;
}

/**
 * A write or read refused because the document was removed under it. Every model path treats
 * it as not-found and words it from the record; only a principal that already reached the
 * document sees it.
 */
export class DocumentRemovedError extends DocumentNotFoundError {
  constructor(
    readonly documentId: DocumentId,
    readonly removal: DocumentRemovalRecord,
  ) {
    super(documentId, `Document ${documentId} was ${removal.reason}`, { removal });
    this.name = "DocumentRemovedError";
  }
}
