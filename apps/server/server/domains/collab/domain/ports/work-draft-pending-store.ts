/** What is pending review in a Work: its text changes by document, counts and the drafts changing a document. */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { WorkDraftPendingCounts } from "../../../projects/ports/work-draft-pending-counts.js";

/** An active draft with changes to one document, oldest first, and the owner it came from. */
export type DocumentDraftOrigin = {
  draftId: DraftId;
  /** Exactly one of these two is set. */
  originWorkId: WorkId | null;
  originRootThreadId: string | null;
  /** The owner's label: a named Work's name, a lineage's first chat title; null when it has none to show. */
  originLabel: string | null;
};

/**
 * A document the draft's owner has suggestions in, as the document's derivation counted them
 * (`document_block_rooms.pending_changes`).
 */
export type WorkDraftTextChanges = {
  documentId: DocumentId;
  draftId: DraftId;
  updatedAt: Date;
  /** How many changes the Work's review shows in the document. */
  textChanges: number;
  /** The chats that wrote them, and whether one is no chat's (the writer's typing). */
  writers: { threadIds: string[]; unattributed: boolean };
};

export type WorkDraftPendingStore = {
  /** Every document the draft's owner has suggestions in (only these documents' when given). */
  listDraftTextChanges(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<WorkDraftTextChanges[]>;
  /**
   * The active drafts with changes to one document, by the one membership predicate of
   * `draft-review-items.ts` (`context/tree/pending-documents.ts`).
   */
  listDraftsChangingDocument(input: {
    projectId: ProjectId;
    documentId: DocumentId;
  }): Promise<DocumentDraftOrigin[]>;
  /** Pending documents summed over the project's active drafts, from the stored draft counts. */
  countPendingInProject(projectId: ProjectId): Promise<number>;
  /** Every active draft of these owners with its pending documents (zero when none). */
  countPendingByOwners: WorkDraftPendingCounts["countPendingByOwners"];
};
