/** Draft capabilities consumed by collab application services. */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { ResolvedDraft } from "../draft-resolver.js";
import type { DraftSnapshot, DraftStore } from "../draft-store.js";

export type ApplicationDraftStore = DraftStore & {
  listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
  /** Every Work draft of the document, any status and branch. */
  listWorkDraftStates(
    documentId: DocumentId,
  ): Promise<{ draftId: string; status: DraftSnapshot["status"] }[]>;
  /** The branch's active draft of the document, or null. */
  findBranchDraft(documentId: DocumentId, branchId: BranchId): Promise<DraftSnapshot | null>;
  /**
   * The branch's draft on the document, made from `liveDoc` if absent: a write boundary
   * only. Never makes a branch; refuses a closed one in the insert's transaction.
   */
  ensureDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
    liveDoc: Y.Doc;
    /** Addressable authority room, or intentional null for created/empty content. */
    liveRoom: string | null;
    livePosition?: number;
  }): Promise<DraftSnapshot>;
  /** The branch's draft on its new document, from its durable live state, in the caller's transaction. */
  ensureCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<DraftSnapshot>;
  /**
   * Close the branch's draft on a document it created, unless it holds a journal row
   * (a contribution).
   */
  retractCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<"stands" | "retracted">;
  /** The thread's owner's active draft on the document, as metadata. */
  resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  /**
   * The owner's active draft on the document, as metadata: its active branch's draft. Null
   * when the owner has no active branch or no draft of the document.
   */
  findOwnerDraft(documentId: DocumentId, owner: DraftOwner): Promise<ResolvedDraft | null>;
};
