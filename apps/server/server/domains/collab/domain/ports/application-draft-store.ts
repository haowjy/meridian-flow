/** Draft capabilities consumed by collab application services. */
import type { ObservationFrontier } from "@meridian/agent-edit/integration";
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
  /**
   * The branch's draft of a living document, made from its live journal in the caller's
   * transaction if absent. Takes no room mutex: a command calls it under its own locks.
   */
  ensureLiveDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
    /** The live cut the writing model last saw: a new draft seeds from it, not from live's head. */
    seen?: ObservationFrontier | null;
  }): Promise<DraftSnapshot>;
  /**
   * The branch's draft on the document its admitted create just made, from its durable live
   * state, in the admitting transaction under the branch's tree list key (no Work lock).
   */
  ensureCreatedDocumentDraft(input: {
    documentId: DocumentId;
    branchId: BranchId;
  }): Promise<DraftSnapshot>;
  /** The thread's owner's active draft on the document, as metadata. */
  resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  /**
   * The owner's active draft on the document, as metadata: its active branch's draft. Null
   * when the owner has no active branch or no draft of the document.
   */
  findOwnerDraft(documentId: DocumentId, owner: DraftOwner): Promise<ResolvedDraft | null>;
};
