/** Wire view-models for listing and reviewing AI document drafts. */

export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active" | "applied" | "discarded";
  lastActorTurnId: string | null;
  updatedAt: string;
  appliedAt: string | null;
  discardedAt: string | null;
  partialAcceptedOperationCount?: number | null;
  proposedOperationCount?: number | null;
  wordsAdded: number | null;
  wordsRemoved: number | null;
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

type ActiveDraftPreviewBase = {
  status: "active";
  branchId?: string;
  draftId?: string;
  /** Hocuspocus room name for inline branch review; already generation-fenced. */
  reviewRoomName?: string;
  live: string;
  preview: string;
  liveRevisionToken: number;
  draftRevisionToken: number;
  notice?: { code: "branch_corrupt_reset"; message: string };
};

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      inlineModelPresent: true;
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | { status: "gone"; live: string };

export type ReviewOperationContribution = "added" | "removed" | "rewrote" | "edited";
export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  operationId: string;
  acceptClosureOperationIds?: string[];
  rejectClosureOperationIds?: string[];
  rejectSourceUpdateIds: number[];
  actorTurnId?: string;
  kind: "agent" | "writer";
  contribution: ReviewOperationContribution;
  classification: ReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
  hunkCount: number;
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

export type DraftAcceptResponse =
  | { status: "applied"; draftId?: string; branchId?: string }
  | { status: "partial_applied"; draftId: string; writeId: string }
  | {
      status: "closure_confirmation_required";
      draftId: string;
      requestedOperationIds: string[];
      closureOperationIds: string[];
      liveRevisionToken: number;
    }
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number }
  | { status: "causal_dependency"; draftId: string; message: string }
  | { status: "cannot_place"; draftId: string }
  | {
      status: "overlap";
      draftId: string;
      liveRevisionToken: number;
      live: string;
      preview: string;
    };

type DraftAcceptRequestBase = {
  draftRevisionToken: number;
  operationIds?: string[];
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
  confirmedClosureOperationIds?: string[];
};

export type DraftAcceptRequest =
  | (DraftAcceptRequestBase & { draftId: string; branchId?: never })
  | {
      branchId: string;
      draftId?: never;
      draftRevisionToken: number;
      operationIds?: never;
      confirmOverlap?: never;
      confirmedLiveRevisionToken?: never;
      confirmedClosureOperationIds?: never;
    };

export type DraftRejectResponse = { status: "discarded"; draftId?: string; branchId?: string };
export type DraftRejectRequest =
  | { draftId: string; branchId?: never }
  | { branchId: string; draftId?: never };
export type DraftUndoResponse = { status: "reactivated"; draftId: string };
export type DraftUndoAcceptRequest = { draftId: string; writeId?: string };
