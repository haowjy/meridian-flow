/** Tree-owned removal protocol. Callers hold Work/namespace and sorted document mutation locks before entering it. */
import type { DocumentId, ThreadId, UserId, WorkId } from "@meridian/contracts";

export type ClosedDocumentDraft = {
  draftId: string;
  documentId: DocumentId;
  threadId: ThreadId | null;
};

export type RemoveDocumentsInput = {
  documentIds: readonly DocumentId[];
  reason: "deleted" | "discarded";
  userId?: UserId;
  workId?: WorkId;
  cause?: "reply_rolled_back" | "create_failed" | "repair";
  at?: Date;
  affectedWorkIds?: readonly WorkId[];
};
export interface DocumentRemoval {
  recount(workIds: readonly WorkId[]): void;
  remove(input: RemoveDocumentsInput): Promise<readonly ClosedDocumentDraft[]>;
}
/** Collab owns draft closure and the after-commit effects, not document tombstones. */
export interface DocumentRemovalCollab {
  recount(workIds: readonly WorkId[]): void;
  closeRemovedDocuments(input: {
    documentIds: readonly DocumentId[];
    workIds: readonly WorkId[];
  }): Promise<readonly ClosedDocumentDraft[]>;
}
