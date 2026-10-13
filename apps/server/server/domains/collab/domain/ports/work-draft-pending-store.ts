/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";

export type WorkDraftPendingEvidence = {
  branch: {
    branchId: string;
    documentId: DocumentId;
    draftId: DraftId;
    generation: number;
    updatedAt: Date;
    /** The pulled-live-cut effect predicate (§3.1): the branch differs from live. */
    hasEffect: boolean;
    /** A held restoration keeps an item listed with no effect. */
    blocking: boolean;
  };
  /** The branch has at least one reviewable journal row. */
  hasRows: boolean;
  /** Chats whose agent writes are pending on the branch, most recent write first, distinct. */
  agentThreadIds: string[];
};

export type WorkDraftPendingStore = {
  /**
   * Every active `work_draft` branch of the draft (only these documents' when given), each
   * with its reviewable rows (maybe none).
   */
  listDraftBranchEvidence(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkDraftPendingEvidence[]>;
  /** The chat that created each document the draft created (§3.3); a writer's create is absent. */
  listCreators(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
  /** The item keys a staged, unfinished batch of this draft holds: progress, never settlement. */
  listSettling(draftId: DraftId): Promise<ReadonlySet<string>>;
  /**
   * Distinct pending documents per Work, by the canonical branch → draft → Work mapping:
   * its active draft's branches with reviewable rows and (`hasEffect` or `blocking`), plus
   * that draft's change rows. The one membership predicate of `draft-review-items.ts`.
   */
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
