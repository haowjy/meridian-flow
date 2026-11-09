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
  /**
   * The chats behind each document's branch row: the one that last moved or deleted it, then
   * the one that created it (§3.3). A writer's create, move or delete names no chat.
   */
  listTreeActors(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, readonly string[]>>;
  /**
   * Distinct pending documents per Work, by the canonical draft → branch → Work mapping:
   * its active branch's active drafts with `hasEffect`, plus
   * that branch's created nodes. The one membership predicate of `branch-review-items.ts`.
   */
  listBranchesChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentBranchOrigin[]>;
  /** Every active branch of these owners with its pending documents (zero when none). */
  countPendingByOwners: WorkBranchPendingCounts["countPendingByOwners"];
};
