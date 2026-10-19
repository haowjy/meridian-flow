/** Draft capabilities consumed by collab application services. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { DraftResolver, ResolvedDraft } from "../draft-resolver.js";
import type { DraftSnapshot, DraftStore } from "../draft-store.js";
import type { PeerRetirementCause, RetiredDraft } from "../peer-retirement.js";

export type ApplicationDraftStore = DraftStore &
  DraftResolver & {
    listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
    /**
     * The branch's draft on the document, made from `liveDoc` if absent: a write boundary
     * only. Never makes a branch; refuses a closed one in the insert's transaction.
     */
    ensureDocumentDraft(input: {
      documentId: DocumentId;
      branchId: BranchId;
      liveDoc: Y.Doc;
    }): Promise<DraftSnapshot>;
    /** The branch's draft on its new document, from its durable live state, in the caller's transaction. */
    ensureCreatedDocumentDraft(input: {
      documentId: DocumentId;
      branchId: BranchId;
    }): Promise<void>;
    /**
     * Close the branch's draft on a document it created and that draft's thread peers,
     * unless any of them holds a journal row that isn't discarded (a contribution).
     * `closed` is exactly the drafts closed, with each peer's thread.
     */
    retractCreatedDocumentDraft(input: { documentId: DocumentId; branchId: BranchId }): Promise<
      | { outcome: "stands" }
      | {
          outcome: "retracted";
          closed: readonly { draftId: string; threadId: ThreadId | null }[];
        }
    >;
    /**
     * The thread's peer of the branch's draft on the document, with its content as it stands
     * (the checkpoint just written for a new peer). Takes the branch it is given, never ensures
     * one; a branch that is no longer active is `DraftStaleUpdateError`.
     */
    ensureThreadPeerDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      branchId: BranchId;
      liveDoc: Y.Doc;
    }): Promise<{ documentDraft: DraftSnapshot; state: Uint8Array }>;
    /**
     * Close the active thread peers of these drafts (a reset or a Discard moved their
     * upstream), in the caller's transaction; exactly the peers closed come back with the
     * caller's `cause`, for their rooms, staged writes and thread state to retire after commit.
     */
    closeThreadPeersOf(
      upstreamDraftIds: readonly string[],
      cause: PeerRetirementCause,
    ): Promise<RetiredDraft[]>;
    /** The thread's primary Work's active draft on the document, as metadata. */
    resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  };
