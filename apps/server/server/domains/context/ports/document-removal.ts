/**
 * Document removal: the tree-owned kernel, the collab half it calls, and the record reader domain
 * code depends on. A removed document refuses as agent-edit's `DocumentNotFoundError` carrying
 * its record (`removal`); every model path words it from that record. Callers of `remove` hold
 * Work/namespace and sorted document mutation locks before entering it.
 */
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
