/**
 * Retiring what a committed transaction ended: the drafts it closed, each with its cause, and
 * the documents it removed. A removed document's live room closes `4208` while the removal still
 * stands (a Work Restore may have committed after it), and so does each draft room the same
 * transaction closed on it; its drafts that stayed open keep their rooms (a delete closes no
 * draft). Any other closed draft's room closes `4205` (`discarded`). Each retired thread peer's staged writes are refused with
 * the reason its cause names (a removal's carries the record) before the thread state the
 * pooled cores hold for that peer goes. It names the peer it retired, so a delayed retirement
 * never reaches a replacement peer of the same thread, and another Work's peers on a shared
 * document keep their staged replies. Durable changes are the closer's, in its transaction;
 * this runs after commit and writes nothing.
 */
import type { RetiredWriteReason } from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";

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
  threadId: ThreadId | null;
  cause: DraftCloseCause;
};

/** Everything one committed root transaction ended. */
export type DraftRetirementBatch = {
  closed: readonly ClosedDraft[];
  removed: ReadonlyMap<DocumentId, DocumentRemovalRecord>;
};

export type DraftRetirement = (batch: DraftRetirementBatch) => Promise<void>;

const REASON_OF_CAUSE = {
  branch_closed: "discarded_draft",
  document_discarded: "discarded_document",
  edit_discarded: "discarded_edit",
} as const satisfies Record<Exclude<DraftCloseCause, object>, RetiredWriteReason>;

export function createDraftRetirement(deps: {
  /** A closed draft's stable room, with the terminal discarded reason. */
  closeDraftRoom(draftId: string): void;
  /**
   * These drafts' rooms and the removed documents' live rooms, `4208`, including rooms still
   * loading. A live room closes only while its document's removal still stands: a Work Restore
   * may have committed since, and its document's new connections are valid.
   */
  closeRemovedRooms(documentIds: readonly string[], draftIds: readonly string[]): Promise<void>;
  agentEdit: Pick<ThreadPeerAgentEditCore, "retireThreadPeers">;
}): DraftRetirement {
  return async ({ closed, removed }) => {
    const ofRemoved = closed.filter((draft) => removed.has(draft.documentId));
    for (const draft of closed)
      if (!removed.has(draft.documentId)) deps.closeDraftRoom(draft.draftId);
    const peersByDocument = new Map<
      DocumentId,
      { threadId: ThreadId; peerDraftId: string; reason: RetiredWriteReason }[]
    >();
    for (const draft of closed) {
      if (!draft.threadId) continue;
      const record = removed.get(draft.documentId);
      // A removal registers every document it selects before closing their drafts, so a draft
      // closed by a removal always finds its record here.
      const reason: RetiredWriteReason = record
        ? { removed: record }
        : REASON_OF_CAUSE[draft.cause as Exclude<DraftCloseCause, object>];
      peersByDocument.set(draft.documentId, [
        ...(peersByDocument.get(draft.documentId) ?? []),
        { threadId: draft.threadId, peerDraftId: draft.draftId, reason },
      ]);
    }
    await Promise.all([
      deps.closeRemovedRooms(
        [...removed.keys()],
        ofRemoved.map((draft) => draft.draftId),
      ),
      (async () => {
        for (const [documentId, peers] of peersByDocument)
          await deps.agentEdit.retireThreadPeers(documentId, peers);
      })(),
    ]);
  };
}
