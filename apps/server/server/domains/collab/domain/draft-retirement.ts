/**
 * Retiring what a committed transaction ended: the drafts it closed, each with its cause, and
 * the documents it removed. A removed document's rooms, live and draft, close `4208`; any other
 * closed draft's room closes stale. Each retired thread peer's staged writes are refused with
 * the reason its cause names (a removal's carries the record) before the thread state the
 * pooled cores hold for that peer goes. It names the peer it retired, so a delayed retirement
 * never reaches a replacement peer of the same thread, and another Work's peers on a shared
 * document keep their staged replies. Durable changes are the closer's, in its transaction;
 * this runs after commit and touches nothing else.
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
  /** A closed draft's rooms on a generation it left. */
  closeDraftRoom(draftId: string): void;
  /** Removed documents' live rooms and these drafts' rooms, `4208`, including rooms still loading. */
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
      const reason: RetiredWriteReason = record
        ? { removed: record }
        : typeof draft.cause === "string"
          ? REASON_OF_CAUSE[draft.cause]
          : { removed: draft.cause.documentRemoved };
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
