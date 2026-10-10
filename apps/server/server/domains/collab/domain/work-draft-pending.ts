/** Canonical pending-review predicate for Work draft branches. */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import type {
  WorkDraftPendingEvidence,
  WorkDraftPendingStore,
} from "./ports/work-draft-pending-store.js";

/** One active `work_draft` branch of a draft and its reviewable rows (maybe none). */
export type DraftBranchEvidence = WorkDraftPendingEvidence;

/** A branch with reviewable rows. */
export type PendingWorkDraft = WorkDraftPendingEvidence;

export type WorkDraftPending = {
  /** The draft's branches with reviewable rows. */
  list(draftId: DraftId): Promise<PendingWorkDraft[]>;
  /** Every active branch of the draft, with or without rows: the review list's branch half. */
  branches(draftId: DraftId): Promise<DraftBranchEvidence[]>;
  /** Pending documents per Work: branches with rows plus its draft's change rows (§13.2). */
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};

export function createWorkDraftPending(store: WorkDraftPendingStore): WorkDraftPending {
  return {
    async list(draftId) {
      return (await store.listDraftBranchEvidence(draftId)).filter(
        (evidence) => evidence.rows.length > 0,
      );
    },
    branches: (draftId) => store.listDraftBranchEvidence(draftId),
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      return store.countPendingByWorkIds(workIds);
    },
  };
}
