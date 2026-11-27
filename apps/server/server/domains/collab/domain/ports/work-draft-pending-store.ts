import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ProjectId, WorkId } from "@meridian/contracts/runtime";
import type { WorkDraftPendingCounts } from "../../../projects/ports/work-draft-pending-counts.js";

/** An active draft with changes to one document, oldest first, and the owner it came from. */
export type DocumentDraftOrigin = {
  draftId: DraftId;
  originWorkId: WorkId | null;
  originRootThreadId: string | null;
  /** The owner's label: a named Work's name, a lineage's first chat title; null when it has none to show. */
  originLabel: string | null;
};

export type WorkDraftTextChanges = {
  documentId: DocumentId;
  draftId: DraftId;
  updatedAt: Date;
  /** Live's version under the fork's removals, base64 (`DraftItem.liveVersion`); null when it removes none. */
  liveVersion: string | null;
  /** The chats that wrote them, and whether one is no chat's (the writer's typing). */
  writers: { threadIds: string[]; unattributed: boolean };
  /** How many changes the fork has, `changedBlocks`' groups (`document_forks.change_count`). */
  changeCount: number;
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
  countPendingInProject(projectId: ProjectId): Promise<number>;
  countPendingByOwners: WorkDraftPendingCounts["countPendingByOwners"];
};
