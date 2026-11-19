/**
 * Retiring what a committed transaction ended: the drafts it deleted and the documents it removed.
 * A removed document's live room closes `4208` while the removal still stands (a Work Restore may
 * have committed after it), and so does each deleted draft's room on it; a draft deleted on its
 * own (its Work's purge) closes its room `4205`, and a document's other drafts keep their rooms
 * (a delete closes no draft). The rows are the ender's, in its transaction; this runs after commit
 * and writes nothing.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

export type EndedDraft = { draftId: string; documentId: DocumentId };

/** Everything one committed root transaction ended. */
export type DraftRetirementBatch = {
  ended: readonly EndedDraft[];
  removed: ReadonlyMap<DocumentId, DocumentRemovalRecord>;
};

export type DraftRetirement = (batch: DraftRetirementBatch) => Promise<void>;

export function createDraftRetirement(deps: {
  /** A deleted draft's stable room, with the terminal ended reason. */
  closeDraftRoom(draftId: string): void;
  /**
   * These drafts' rooms and the removed documents' live rooms, `4208`, including rooms still
   * loading. A live room closes only while its document's removal still stands: a Work Restore
   * may have committed since, and its document's new connections are valid.
   */
  closeRemovedRooms(documentIds: readonly string[], draftIds: readonly string[]): Promise<void>;
}): DraftRetirement {
  return async ({ ended, removed }) => {
    for (const draft of ended)
      if (!removed.has(draft.documentId)) deps.closeDraftRoom(draft.draftId);
    await deps.closeRemovedRooms(
      [...removed.keys()],
      ended.filter((draft) => removed.has(draft.documentId)).map((draft) => draft.draftId),
    );
  };
}
