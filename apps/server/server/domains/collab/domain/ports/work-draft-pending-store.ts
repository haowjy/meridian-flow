/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { BranchJournalRow } from "../branch-push-contracts.js";

export type WorkDraftPendingRowEvidence = Pick<BranchJournalRow, "turnId" | "updateMeta">;

export type WorkDraftPendingEvidence = {
  branch: {
    branchId: string;
    documentId: DocumentId;
    draftId: DraftId;
    generation: number;
  };
  rows: WorkDraftPendingRowEvidence[];
};

export type WorkDraftPendingStore = {
  /** The draft's branches with reviewable rows, each with its current-generation rows. */
  listReviewableEvidenceForDraft(draftId: DraftId): Promise<WorkDraftPendingEvidence[]>;
  /** Per Work, by the canonical branch → draft → Work mapping. */
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
