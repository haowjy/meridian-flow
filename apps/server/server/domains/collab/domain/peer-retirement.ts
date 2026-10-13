/**
 * Retiring exactly the branches a committed change closed or deleted: their branch rooms
 * close, and each retired peer's staged writes are refused with the reason its cause names
 * before the thread state the pooled cores hold for that peer (runtimes, pulled baselines)
 * goes. Durable branch changes are the caller's, in its transaction; this runs after commit
 * and touches nothing else. It names the peer it retired, so a delayed retirement never
 * reaches a replacement peer of the same thread, and another Work's peers on a shared
 * document keep their staged replies.
 */
import type { DiscardedWriteReason } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";

/** Why a thread peer's draft branch ended: the draft, the created document, or the edited text. */
export type PeerRetirementCause = "draft_closed" | "document_discarded" | "edit_discarded";

/** A branch a committed change closed or deleted; a thread peer says why. */
export type RetiredBranch =
  | { branchId: string; documentId: DocumentId; threadId: null }
  | { branchId: string; documentId: DocumentId; threadId: ThreadId; cause: PeerRetirementCause };

export type PeerRetirement = (branches: readonly RetiredBranch[]) => Promise<void>;

const REASON_OF_CAUSE: Record<PeerRetirementCause, DiscardedWriteReason> = {
  draft_closed: "discarded_draft",
  document_discarded: "discarded_document",
  edit_discarded: "discarded_edit",
};

export function createPeerRetirement(deps: {
  closeBranchRoom(branchId: string): void;
  agentEdit: Pick<ThreadPeerAgentEditCore, "retireThreadPeers">;
}): PeerRetirement {
  return async (branches) => {
    const peersByDocument = new Map<
      DocumentId,
      { threadId: ThreadId; peerBranchId: string; reason: DiscardedWriteReason }[]
    >();
    for (const branch of branches) {
      deps.closeBranchRoom(branch.branchId);
      if (!branch.threadId) continue;
      peersByDocument.set(branch.documentId, [
        ...(peersByDocument.get(branch.documentId) ?? []),
        {
          threadId: branch.threadId,
          peerBranchId: branch.branchId,
          reason: REASON_OF_CAUSE[branch.cause],
        },
      ]);
    }
    for (const [documentId, peers] of peersByDocument) {
      await deps.agentEdit.retireThreadPeers(documentId, peers);
    }
  };
}
