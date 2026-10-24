/**
 * Document removal: the tree-owned kernel, the collab half it calls, and the record reader domain
 * code depends on. A removed document refuses as agent-edit's `DocumentNotFoundError` carrying
 * its record (`removal`); every model path words it from that record. Callers of `remove` hold
 * Work/namespace and sorted document mutation locks before entering it.
 */
import type { DocumentId, RemovalIdentity, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentRemovalCause, DocumentRemovalRecord } from "@meridian/contracts/protocol";

type RemoveDocumentsInput = {
  documentIds: readonly DocumentId[];
  reason: "deleted" | "discarded";
  userId?: UserId;
  /** A model's delete: the chat it ran in. Its owner becomes `userId` when none is given. */
  threadId?: ThreadId;
  /** A Work cascade: the Work whose deletion removes these, so its Restore brings them back. */
  workId?: WorkId;
  cause?: DocumentRemovalCause;
  at?: Date;
};

export interface DocumentRemoval {
  /** Tombstones the living ones among `documentIds` and returns exactly those removals. */
  remove(
    input: RemoveDocumentsInput,
  ): Promise<readonly { documentId: DocumentId; removal: RemovalIdentity }[]>;
}

/**
 * Collab's half. Every removal registers its documents, so their live rooms close `4208` once
 * the transaction commits; a delete closes no draft, since a draft outlives a live delete of its
 * document (D79). A discard also closes every active draft on its documents and names the Works
 * those drafts belonged to (their pending counts moved).
 */
export interface DocumentRemovalCollab {
  registerRemoved(documentIds: readonly DocumentId[], record: DocumentRemovalRecord): void;
  closeDiscardedDrafts(
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
