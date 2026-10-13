/** Canonical pending-review predicate for Work draft branches. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { manifestMembershipRowDocumentId } from "./manifest-membership-journal.js";
import type {
  WorkDraftPendingEvidence,
  WorkDraftPendingRowEvidence,
  WorkDraftPendingStore,
} from "./ports/work-draft-pending-store.js";

export type PendingWorkDraft = {
  branch: WorkDraftPendingEvidence["branch"];
  rows: WorkDraftPendingRowEvidence[];
  actorThreadIds: string[];
  manifestEntry?: {
    branchId: string;
    documentId: DocumentId;
  };
};

export type WorkDraftPending = {
  list(workId: WorkId): Promise<PendingWorkDraft[]>;
  countPendingByWorkIds(workIds: readonly WorkId[]): Promise<ReadonlyMap<WorkId, number>>;
};

export function createWorkDraftPending(store: WorkDraftPendingStore): WorkDraftPending {
  async function list(workId: WorkId): Promise<PendingWorkDraft[]> {
    const evidence = await store.listReviewableEvidenceForWork(workId);
    const manifestEntries = new Map<DocumentId, PendingWorkDraft["manifestEntry"]>();
    for (const { branch, rows } of evidence) {
      for (const row of rows) {
        const documentId = manifestMembershipRowDocumentId(row);
        if (documentId) manifestEntries.set(documentId, { branchId: branch.branchId, documentId });
      }
    }
    return evidence.flatMap(({ branch, rows }) => {
      const contentRows = rows.filter((row) => manifestMembershipRowDocumentId(row) === null);
      if (contentRows.length === 0) return [];
      const manifestEntry = manifestEntries.get(branch.documentId);
      const latestThreadRows = new Map<string, number>();
      for (const row of contentRows) {
        if (row.source !== "agent" || !row.threadId) continue;
        latestThreadRows.set(
          row.threadId,
          Math.max(latestThreadRows.get(row.threadId) ?? 0, row.id),
        );
      }
      const actorThreadIds = [...latestThreadRows]
        .sort((a, b) => b[1] - a[1])
        .map(([threadId]) => threadId);
      return [
        { branch, rows: contentRows, actorThreadIds, ...(manifestEntry ? { manifestEntry } : {}) },
      ];
    });
  }

  return {
    list,
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      return store.countPendingByWorkIds(workIds);
    },
  };
}
