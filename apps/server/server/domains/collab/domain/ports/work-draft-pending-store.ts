/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";

/** An active draft with changes to one document, oldest first, and the Work it came from. */
export type DocumentDraftOrigin = {
  draftId: DraftId;
  originWorkId: WorkId;
  /** The origin Work's name; null for the locked No Work row, which has none to show. */
  originWorkName: string | null;
};

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
  listDraftsChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentDraftOrigin[]>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
