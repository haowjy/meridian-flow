/** Loads active Work-draft membership and text-derived conversation evidence. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { WorkBranchPendingCounts } from "../../../projects/ports/work-branch-pending-counts.js";

/** An active branch with changes to one document, oldest first, and the owner it came from. */
export type DocumentBranchOrigin = {
  branchId: BranchId;
  /** Exactly one of these two is set. */
  originWorkId: WorkId | null;
  originRootThreadId: string | null;
  /** The owner's label: a named Work's name, a lineage's first chat title; null when it has none to show. */
  originLabel: string | null;
};

/**
 * A document the branch has text changes in: an active `work_draft` draft, or (suggestion mode)
 * the branch owner's suggestions in the Live document, which have no draft (`draftId` null) and
 * whose writers the document's derivation already counted (`writers`).
 */
export type WorkBranchDraftMetadata = {
  draftId: string | null;
  documentId: DocumentId;
  branchId: BranchId;
  updatedAt: Date;
  /** Whether the draft differs from its review base. */
  hasEffect: boolean;
  /** How many review groups that difference makes, judged with `hasEffect`. */
  textChanges: number;
  /** Who wrote the pending changes, when known without reading a draft. */
  writers?: { threadIds: string[]; unattributed: boolean };
};

export type WorkBranchPendingStore = {
  /**
   * Every document the branch has text changes in (only these documents' when given): its active
   * `work_draft` drafts and the documents holding its owner's suggestions, each with metadata
   * only: no materialization or receipt classification.
   */
  listBranchDraftMetadata(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkBranchDraftMetadata[]>;
  /**
   * Who wrote the draft's pending changes, for list/report enrichment only: the chats behind its
   * receipts (latest first, distinct), and whether any change has none, which is the writer's own
   * typing or evidence in doubt.
   */
  pendingWriters(draftId: string): Promise<{ threadIds: string[]; unattributed: boolean }>;
  /**
   * Distinct pending documents per Work, by the canonical draft → branch → Work mapping:
   * its active branch's active drafts with `hasEffect`, plus
   * that branch's created nodes. The one membership predicate of `branch-review-items.ts`.
   */
  listBranchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentBranchOrigin[]>;
  /** Pending documents summed over the project's active branches, from the stored branch counts. */
  countPendingInProject(projectId: ProjectId): Promise<number>;
  /** Every active branch of these owners with its pending documents (zero when none). */
  countPendingByOwners: WorkBranchPendingCounts["countPendingByOwners"];
};
