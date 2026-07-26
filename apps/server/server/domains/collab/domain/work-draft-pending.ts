/** Canonical pending-review predicate for Work draft branches. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import type {
  BranchJournalReadStore,
  BranchJournalRow,
  WorkPushPolicyStore,
} from "./branch-push-contracts.js";
import { manifestMembershipRowDocumentId } from "./manifest-membership-journal.js";

export type PendingWorkDraft = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
};

export type WorkDraftPending = {
  list(workId: WorkId): Promise<PendingWorkDraft[]>;
  count(workId: WorkId): Promise<number>;
};

export function createWorkDraftPending(input: {
  branches: Pick<BranchStore, "getBranch">;
  branchJournal: Pick<BranchJournalReadStore, "listReviewableJournalRows">;
  workDraftIndex: Pick<WorkPushPolicyStore, "listActiveWorkDraftBranchIdsForWork">;
}): WorkDraftPending {
  async function list(workId: WorkId): Promise<PendingWorkDraft[]> {
    const branchIds = await input.workDraftIndex.listActiveWorkDraftBranchIdsForWork(workId);
    const pending: PendingWorkDraft[] = [];
    for (const branchId of branchIds) {
      const branch = await input.branches.getBranch(branchId);
      if (branch?.kind !== "work_draft" || branch.status !== "active" || branch.workId !== workId) {
        continue;
      }
      const rows = (
        await input.branchJournal.listReviewableJournalRows(branch.branchId, branch.generation)
      ).filter((row) => manifestMembershipRowDocumentId(row) === null);
      if (rows.length > 0) pending.push({ branch, rows });
    }
    return pending;
  }

  return {
    list,
    async count(workId) {
      return (await list(workId)).length;
    },
  };
}
