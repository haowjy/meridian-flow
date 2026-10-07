export type WIdRange = { min: number; max: number };

/** Wire view-models for listing and reviewing AI document drafts. */

export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active";
  lastActorTurnId: string | null;
  updatedAt: string;
  proposedOperationCount?: number | null;
  wordsAdded: number | null;
  wordsRemoved: number | null;
  /**
   * the draft contains a document outside the writer's live project manifest.
   * Drives the dock row `New` badge + additions-only stats and the review
   * card's `New document` variant. Derived server-side from the branching
   * model; consumed here. Absent/false = edit of a live document.
   */
  isNewDocument?: boolean;
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

type ActiveDraftPreviewBase = {
  status: "active";
  draftId: string;
  /** Hocuspocus room name for inline branch review; already generation-fenced. */
  reviewRoomName: string;
  live: string;
  preview: string;
  liveRevisionToken: string;
  draftRevisionToken: string;
  notice?: { code: "branch_corrupt_reset"; message: string };
  /**
   * mirrors `ThreadDraftListItem.isNewDocument` (spec §5.5) so the
   * open review can render the all-additions `New document` card variant
   * without a second lookup. Produced by the server preview builder.
   * Per-change Apply is unavailable when true; use whole-document Apply.
   */
  isNewDocument?: boolean;
};

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      inlineModelPresent: true;
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | { status: "gone"; draftId: string; live: string };

export type ReviewOperationContribution = "added" | "removed" | "rewrote" | "edited";
export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  operationId: string;
  actorTurnId?: string;
  /**
   * Server-vended closure-class id. Every operation in one journal-backed
   * dependency-closed review class carries the same id; the review surface renders
   * one change per distinct id.
   */
  closureClassId: string;
  kind: "agent" | "writer";
  contribution: ReviewOperationContribution;
  classification: ReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
  hunkCount: number;
  /** Writer responsible for a writer-origin operation. */
  actorUserId?: string;
}

export interface ReviewHunkSpan {
  anchorFrom: string;
  anchorTo: string;
  operationId: string;
}

type ReviewHunkBase = {
  hunkId: string;
  operationIds: string[];
  anchor: {
    relStart: string;
    relEnd: string;
  };
  /** True when surviving inserted text has both insertion boundaries in context removed by the other author. Mixed author spans alone are not a merge artifact. */
  mergeArtifact?: boolean;
};

export type ReviewTextHunk = ReviewHunkBase & {
  kind: "text";
  spans: ReviewHunkSpan[];
  deletedText?: string;
};

export type ReviewBlockDisplay = { type: string; display: string };

export type ReviewBlockHunk = ReviewHunkBase & {
  kind: "block";
  insertedBlock?: ReviewBlockDisplay;
  deletedBlock?: ReviewBlockDisplay;
};

export type ReviewHunk = ReviewTextHunk | ReviewBlockHunk;

export type DraftApplyResponse = { status: "applied"; draftId: string };
export type DraftApplyRequest = { draftId: string };

export type DraftDiscardResponse = { status: "discarded"; draftId: string };
export type DraftDiscardRequest = { draftId: string; operationIds?: string[] };

/** Select complete server-vended classes. Physical journal IDs never cross the wire. */
export type DraftApplyChangesRequest = {
  draftId: string;
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};
export type DraftApplyChangesResponse =
  | { status: "applied"; draftId: string; operationIds: string[]; closureClassIds: string[] }
  | { status: "stale" | "gone" | "draft_only" | "incomplete_class"; draftId: string };
