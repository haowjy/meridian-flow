/** Loads active Work-draft membership and text-derived conversation evidence. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";

/** An active branch with changes to one document, oldest first, and the Work it came from. */
export type DocumentBranchOrigin = {
  branchId: BranchId;
  originWorkId: WorkId;
  /** The origin Work's name; null for the locked No Work row, which has none to show. */
  originWorkName: string | null;
};

export type WorkBranchDraftMetadata = {
  draftId: string;
  documentId: DocumentId;
  branchId: BranchId;
  updatedAt: Date;
  /** Whether the draft differs from its review base. */
  hasEffect: boolean;
};

export type WorkBranchPendingStore = {
  /**
   * Every active `work_draft` draft of the branch (only these documents' when given), each
   * with metadata only: no materialization or receipt classification.
   */
  listBranchDraftMetadata(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkBranchDraftMetadata[]>;
  /** Receipt members for list/report enrichment only, latest first and distinct. */
  pendingThreadIds(draftId: string): Promise<string[]>;
  /** The chat that created each document the branch created (§3.3); a writer's create is absent. */
  listCreators(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
  /**
   * Distinct pending documents per Work, by the canonical draft → branch → Work mapping:
   * its active branch's active drafts with `hasEffect`, plus
   * that branch's created nodes. The one membership predicate of `branch-review-items.ts`.
   */
  listBranchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentBranchOrigin[]>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
