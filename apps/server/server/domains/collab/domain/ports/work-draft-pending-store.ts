/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { BranchJournalRow } from "../branch-push-contracts.js";

export type WorkDraftPendingEvidence = {
  branch: {
    branchId: string;
    documentId: DocumentId;
    workId: WorkId;
    generation: number;
  };
  rows: BranchJournalRow[];
};

export type WorkDraftPendingStore = {
  listReviewableEvidenceForWork(workId: WorkId): Promise<WorkDraftPendingEvidence[]>;
};
