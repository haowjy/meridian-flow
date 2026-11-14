/**
 * Retiring what a committed transaction ended: the drafts it closed, each with its cause, and
 * the documents it removed. A removed document's live room closes `4208` while the removal still
 * stands (a Work Restore may have committed after it), and so does each draft room the same
 * transaction closed on it; its drafts that stayed open keep their rooms (a delete closes no
 * draft). Any other closed draft's room closes `4205` (`discarded`), and a draft a command closed
 * only while that command still holds it: a restore that reopened the draft first leaves its room
 * to the peers that joined since. Durable changes are the closer's, in its transaction; this runs
 * after commit and writes nothing.
 */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

/**
 * Why drafts end: their branch closed, their created document was discarded, their edited
 * text was discarded, or their document was removed (with its record).
 */
export type DraftCloseCause =
  | "branch_closed"
  | "document_discarded"
  | "edit_discarded"
  | { documentRemoved: DocumentRemovalRecord };

export type ClosedDraft = {
  draftId: string;
  documentId: DocumentId;
  cause: DraftCloseCause;
  /** The Discard or restore command that closed it: a restore may reopen the draft before this runs. */
  by?: string;
};

/** Everything one committed root transaction ended. */
export type DraftRetirementBatch = {
  closed: readonly ClosedDraft[];
  removed: ReadonlyMap<DocumentId, DocumentRemovalRecord>;
};

export type DraftRetirement = (batch: DraftRetirementBatch) => Promise<void>;

export function createDraftRetirement(deps: {
  /** A closed draft's stable room, with the terminal discarded reason. */
  closeDraftRoom(draftId: string): void;
  /**
   * These drafts' rooms and the removed documents' live rooms, `4208`, including rooms still
   * loading. A live room closes only while its document's removal still stands: a Work Restore
   * may have committed since, and its document's new connections are valid.
   */
  closeRemovedRooms(documentIds: readonly string[], draftIds: readonly string[]): Promise<void>;
  /** Of these command-closed drafts, the ids whose row still names the command that closed it. */
  stillClosedBy(drafts: readonly { draftId: string; by: string }[]): Promise<ReadonlySet<string>>;
}): DraftRetirement {
  return async (batch) => {
    const { removed } = batch;
    const commanded = batch.closed.flatMap(({ draftId, by }) => (by ? [{ draftId, by }] : []));
    const holding = commanded.length ? await deps.stillClosedBy(commanded) : new Set<string>();
    const closed = batch.closed.filter((draft) => !draft.by || holding.has(draft.draftId));
    const ofRemoved = closed.filter((draft) => removed.has(draft.documentId));
    for (const draft of closed)
      if (!removed.has(draft.documentId)) deps.closeDraftRoom(draft.draftId);
    await deps.closeRemovedRooms(
      [...removed.keys()],
      ofRemoved.map((draft) => draft.draftId),
    );
  };
}
