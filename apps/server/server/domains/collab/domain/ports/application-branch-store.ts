/** Branch capabilities consumed by collab application services. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { BranchSnapshot, BranchStore } from "../branch-coordinator.js";
import type { BranchResolver, BranchState } from "../branch-resolver.js";

export type ApplicationBranchStore = BranchStore &
  BranchResolver & {
    appendJournal(
      input: import("../branch-coordinator.js").AppendBranchJournalInput,
    ): Promise<void>;
    listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
    /** Every active branch of the draft, both kinds. */
    listActiveDraftBranchIds(draftId: DraftId): Promise<string[]>;
    /** The draft's branch on the document, made from `liveDoc` if absent. Never makes a draft. */
    ensureDraftBranch(input: {
      documentId: DocumentId;
      draftId: DraftId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    /** The draft's branch on its new document, from its durable live state, in the caller's transaction. */
    ensureCreatedDraftBranch(input: { documentId: DocumentId; draftId: DraftId }): Promise<void>;
    /**
     * Delete the draft's branch on a document it created and that branch's thread peers,
     * unless any of them holds a journal row that isn't discarded (a contribution).
     * `deleted` is exactly the branches removed, with each peer's thread.
     */
    retractCreatedDraftBranch(input: { documentId: DocumentId; draftId: DraftId }): Promise<
      | { outcome: "stands" }
      | {
          outcome: "retracted";
          deleted: readonly { branchId: string; threadId: ThreadId | null }[];
        }
    >;
    /**
     * The thread's peer of the draft's branch on the document. Takes the draft it is given,
     * never ensures one; a draft that is no longer active is `BranchStaleUpdateError`.
     */
    ensureThreadPeerBranch(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      draftId: DraftId;
      liveDoc: Y.Doc;
    }): Promise<BranchSnapshot>;
    discardActiveThreadPeerBranches(input: {
      documentId: DocumentId;
      threadId?: ThreadId | null;
    }): Promise<void>;
    resolveWorkDraftBranchForThread(
      documentId: DocumentId,
      threadId: ThreadId,
    ): Promise<BranchState>;
    resolveDraftBranch(input: {
      documentId: DocumentId;
      draftId: DraftId;
      liveDoc: Y.Doc;
    }): Promise<BranchState>;
  };

/**
 * Discards one Work draft without applying content to live; a document the Work's draft
 * created ends that draft's use (bridge until lane D's `discardItems`).
 */
export type WorkDraftDiscard = (input: {
  createdBy?: DraftId;
  workId: WorkId;
  documentId: DocumentId;
  contentBranchId: string;
}) => Promise<void>;
