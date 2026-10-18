/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";

/** An active branch with changes to one document, oldest first, and the Work it came from. */
export type DocumentDraftOrigin = {
  branchId: BranchId;
  originWorkId: WorkId;
  /** The origin Work's name; null for the locked No Work row, which has none to show. */
  originWorkName: string | null;
};

export type WorkBranchPendingEvidence = {
  documentDraft: {
    draftId: string;
    documentId: DocumentId;
    branchId: BranchId;
    generation: number;
    updatedAt: Date;
    /** The pulled-live-cut effect predicate (§3.1): the draft differs from live. */
    hasEffect: boolean;
    /** A held restoration keeps an item listed with no effect. */
    blocking: boolean;
  };
  /** The draft has at least one reviewable journal row. */
  hasRows: boolean;
  /** Chats whose agent writes are pending on the draft, most recent write first, distinct. */
  agentThreadIds: string[];
};

export type WorkBranchPendingStore = {
  /**
   * Every active `work_draft` draft of the branch (only these documents' when given), each
   * with its reviewable rows (maybe none).
   */
  listBranchDraftEvidence(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkBranchPendingEvidence[]>;
  /** The chat that created each document the branch created (§3.3); a writer's create is absent. */
  listCreators(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
  /** The item keys a staged, unfinished batch of this branch holds: progress, never settlement. */
  listSettling(branchId: BranchId): Promise<ReadonlySet<string>>;
  /**
   * Distinct pending documents per Work, by the canonical draft → branch → Work mapping:
   * its active branch's drafts with reviewable rows and (`hasEffect` or `blocking`), plus
   * that branch's change rows. The one membership predicate of `draft-review-items.ts`.
   */
  listBranchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentDraftOrigin[]>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
