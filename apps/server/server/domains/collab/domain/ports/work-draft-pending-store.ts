/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { BranchJournalRow } from "../branch-push-contracts.js";

export type WorkDraftPendingRowEvidence = Pick<BranchJournalRow, "turnId" | "updateMeta">;

export type WorkDraftPendingEvidence = {
  branch: {
    branchId: string;
    documentId: DocumentId;
    workId: WorkId;
    generation: number;
  };
  rows: WorkDraftPendingRowEvidence[];
};

export type WorkDraftPendingStore = {
  listReviewableEvidenceForWork(workId: WorkId): Promise<WorkDraftPendingEvidence[]>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
