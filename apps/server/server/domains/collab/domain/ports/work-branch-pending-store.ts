/** What is pending review in a Work: its text changes by document, counts and the branches changing a document. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { WorkBranchPendingCounts } from "../../../projects/ports/work-branch-pending-counts.js";

/** An active branch with changes to one document, oldest first, and the owner it came from. */
export type DocumentBranchOrigin = {
  branchId: DraftId;
  /** Exactly one of these two is set. */
  originWorkId: WorkId | null;
  originRootThreadId: string | null;
  /** The owner's label: a named Work's name, a lineage's first chat title; null when it has none to show. */
  originLabel: string | null;
};

/**
 * A document the branch's owner has suggestions in, as the document's derivation counted them
 * (`document_block_rooms.pending_changes`).
 */
export type WorkBranchTextChanges = {
  documentId: DocumentId;
  branchId: DraftId;
  updatedAt: Date;
  /** How many changes the Work's review shows in the document. */
  textChanges: number;
  /** The chats that wrote them, and whether one is no chat's (the writer's typing). */
  writers: { threadIds: string[]; unattributed: boolean };
};

export type WorkBranchPendingStore = {
  /** Every document the branch's owner has suggestions in (only these documents' when given). */
  listBranchTextChanges(
    branchId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkBranchTextChanges[]>;
  /**
   * The active branches with changes to one document, by the one membership predicate of
   * `branch-review-items.ts` (`context/tree/pending-documents.ts`).
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
