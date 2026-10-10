/** Loads current-generation Work-draft journal evidence for pending-review classification. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { BranchJournalRow } from "../branch-push-contracts.js";

export type WorkDraftPendingRowEvidence = Pick<BranchJournalRow, "turnId">;

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
  /** Every active `work_draft` branch of the draft, each with its reviewable rows (maybe none). */
  listDraftBranchEvidence(draftId: DraftId): Promise<WorkDraftPendingEvidence[]>;
  /**
   * Distinct pending documents per Work, by the canonical branch → draft → Work mapping:
   * its active draft's branches with reviewable rows, plus that draft's change rows.
   */
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};
