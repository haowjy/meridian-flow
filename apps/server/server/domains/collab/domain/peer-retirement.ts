/**
 * Retiring exactly the branches a committed change closed or deleted: their branch rooms
 * close and the thread state the pooled cores hold for those peer identities goes
 * (staged buffers, runtimes, pulled baselines). Durable branch changes are the caller's,
 * in its transaction; this runs after commit and touches nothing else, so another Work's
 * peers on a shared document keep their staged replies. A freshly ensured peer in the
 * same thread also survives an older peer's delayed retirement.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";

/** A branch a committed change closed or deleted; `threadId` set for a thread peer. */
export type RetiredBranch = { branchId: string; documentId: DocumentId; threadId: ThreadId | null };

export type PeerRetirement = (branches: readonly RetiredBranch[]) => Promise<void>;

export function createPeerRetirement(deps: {
  closeBranchRoom(branchId: string): void;
  agentEdit: Pick<ThreadPeerAgentEditCore, "retireThreadPeers">;
}): PeerRetirement {
  return async (branches) => {
    const threadsByDocument = new Map<DocumentId, { threadId: ThreadId; peerBranchId: string }[]>();
    for (const branch of branches) {
      deps.closeBranchRoom(branch.branchId);
      if (!branch.threadId) continue;
      threadsByDocument.set(branch.documentId, [
        ...(threadsByDocument.get(branch.documentId) ?? []),
        { threadId: branch.threadId, peerBranchId: branch.branchId },
      ]);
    }
    for (const [documentId, peers] of threadsByDocument) {
      await deps.agentEdit.retireThreadPeers(documentId, peers);
    }
  };
}
