/**
 * Retiring exactly the drafts a committed change closed or deleted: their draft rooms
 * close, and each retired peer's staged writes are refused with the reason its cause names
 * before the thread state the pooled cores hold for that peer (runtimes, pulled baselines)
 * goes. Durable draft changes are the caller's, in its transaction; this runs after commit
 * and touches nothing else. It names the peer it retired, so a delayed retirement never
 * reaches a replacement peer of the same thread, and another Work's peers on a shared
 * document keep their staged replies.
 */
import type { DiscardedWriteReason } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";

/** Why a thread-peer draft ended: its branch closed, its created document was discarded, or its edited text was discarded. */
export type PeerRetirementCause = "branch_closed" | "document_discarded" | "edit_discarded";

/** A draft a committed change closed or deleted; a thread peer says why. */
export type RetiredDraft =
  | { draftId: string; documentId: DocumentId; threadId: null }
  | { draftId: string; documentId: DocumentId; threadId: ThreadId; cause: PeerRetirementCause };

export type PeerRetirement = (drafts: readonly RetiredDraft[]) => Promise<void>;

const REASON_OF_CAUSE: Record<PeerRetirementCause, DiscardedWriteReason> = {
  branch_closed: "discarded_draft",
  document_discarded: "discarded_document",
  edit_discarded: "discarded_edit",
};

export function createPeerRetirement(deps: {
  closeDraftRoom(draftId: string): void;
  agentEdit: Pick<ThreadPeerAgentEditCore, "retireThreadPeers">;
}): PeerRetirement {
  return async (drafts) => {
    const peersByDocument = new Map<
      DocumentId,
      { threadId: ThreadId; peerDraftId: string; reason: DiscardedWriteReason }[]
    >();
    for (const documentDraft of drafts) {
      deps.closeDraftRoom(documentDraft.draftId);
      if (!documentDraft.threadId) continue;
      peersByDocument.set(documentDraft.documentId, [
        ...(peersByDocument.get(documentDraft.documentId) ?? []),
        {
          threadId: documentDraft.threadId,
          peerDraftId: documentDraft.draftId,
          reason: REASON_OF_CAUSE[documentDraft.cause],
        },
      ]);
    }
    for (const [documentId, peers] of peersByDocument) {
      await deps.agentEdit.retireThreadPeers(documentId, peers);
    }
  };
}
