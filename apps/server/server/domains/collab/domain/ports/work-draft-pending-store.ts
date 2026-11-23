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

/** A document the draft has a pending fork of (`document_forks.pending`). */
export type WorkDraftTextChanges = {
  documentId: DocumentId;
  draftId: DraftId;
  /** When the fork's flag was last read: its room's last save. */
  updatedAt: Date;
  /** Live's version under the fork's removals, base64 (`DraftItem.liveVersion`); null when it removes none. */
  liveVersion: string | null;
  /** The chats that wrote them, and whether one is no chat's (the writer's typing). */
  writers: { threadIds: string[]; unattributed: boolean };
  /** How many changes the fork has, as Review changes groups them (`document_forks.changes`). */
  changes: number;
};

export type WorkDraftPendingStore = {
  /** Every document the draft has a pending fork of (only these documents' when given). */
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
