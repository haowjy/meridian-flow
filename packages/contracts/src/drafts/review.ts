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
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

type ActiveDraftPreviewBase = {
  status: "active";
  draftId: string;
  live: string;
  preview: string;
  liveRevisionToken: number;
  draftRevisionToken: number;
};

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      inlineModelPresent: true;
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | (ActiveDraftPreviewBase & {
      inlineModelPresent: false;
      /** Present only when the preview can still expose a trustworthy operation set. */
      operationIds?: string[];
      operations?: never;
      hunks?: never;
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

export interface ReviewHunk {
  hunkId: string;
  operationIds: string[];
  anchor: {
    relStart: string;
    relEnd: string;
  };
  spans: ReviewHunkSpan[];
  deletedText?: string;
}

export type DraftAcceptResponse =
  | { status: "applied"; draftId: string }
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
  | {
      status: "overlap";
      draftId: string;
      liveRevisionToken: number;
      live: string;
      preview: string;
    };

export type DraftAcceptRequest = {
  draftId: string;
  draftRevisionToken: number;
  operationIds?: string[];
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
  confirmedClosureOperationIds?: string[];
};

export type DraftRejectResponse = { status: "discarded"; draftId: string };
export type DraftRejectRequest = { draftId: string };
export type DraftUndoResponse = { status: "reactivated"; draftId: string };
export type DraftUndoAcceptRequest = { draftId: string; writeId?: string };
