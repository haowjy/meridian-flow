/** JSON wire contracts for reviewing AI document drafts before they touch live documents. */
export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active" | "applied" | "discarded";
  lastActorTurnId: string | null;
  updatedAt: string;
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

export type DraftReviewSurface = "inline";
export type DraftReviewFallbackReason = "unsupported_node_type";

type ActiveDraftPreviewBase = {
  status: "active";
  draftId: string;
  live: string;
  preview: string;
  liveRevisionToken: number;
  draftRevisionToken: number;
  recommendedSurface: "inline" | "panel";
  fallbackReason?: DraftReviewFallbackReason;
};

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      inlineModelPresent: true;
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | (ActiveDraftPreviewBase & { inlineModelPresent: false; operations?: never; hunks?: never })
  | { status: "gone"; live: string };

export type ReviewOperationContribution = "added" | "removed" | "rewrote" | "edited";
export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  operationId: string;
  sourceUpdateIds: number[];
  /** Row IDs to merge when accepting this operation without closure drag. */
  acceptSourceUpdateIds?: number[];
  /**
   * Server-computed accept closure: accepting this operation applies every
   * operation id in this list (hunk-sharing plus Yjs causal drag).
   */
  acceptClosureOperationIds?: string[];
  /**
   * Union of source update rows for this operation's hunk-sharing closure.
   * Rejecting exactly this set returns every region affected by the connected
   * hunks to the live document state; clients must not infer a narrower reject
   * target from sourceUpdateIds.
   */
  rejectSourceUpdateIds: number[];
  actorTurnId?: string;
  actorUserId?: string;
  kind: "agent" | "writer";
  /** Operation-owned edit shape; does not include neighboring ops in shared hunks. */
  contribution: ReviewOperationContribution;
  /** Server-computed semantic shape; clients own display strings/i18n. */
  classification: ReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
  hunkCount: number;
}

export interface DraftJournalUpdateWire {
  seq: number;
  update: string;
}

export interface DraftJournalResponse {
  draftId: string;
  draftRevisionToken: number;
  checkpoint: string | null;
  updates: DraftJournalUpdateWire[];
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

export type WIdRange = { min: number; max: number };

export type DraftAcceptResponse =
  | { status: "applied"; draftId: string; appliedUpdateSeq: number }
  | {
      status: "partial_applied";
      draftId: string;
      appliedUpdateSeq: number;
      acceptedOperationIds: string[];
      writeId: string;
    }
  | {
      status: "closure_confirmation_required";
      draftId: string;
      requestedOperationIds: string[];
      closureOperationIds: string[];
    }
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number }
  | { status: "causal_dependency"; draftId: string; message: string }
  | {
      status: "overlap";
      draftId: string;
      liveRevisionToken: number;
      live: string;
      preview: string;
      overlappingBlocks: string[];
    };

export type DraftAcceptRequest = {
  draftId: string;
  draftRevisionToken: number;
  operationIds?: string[];
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
  /** Proceed after the server reported a larger accept closure than requested. */
  confirmedClosure?: boolean;
};

export type DraftRejectResponse = { status: "discarded"; draftId: string };

export type DraftRejectRequest = {
  draftId: string;
};

/** 1-day retention window for draft undo operations. */
export const DRAFT_UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Success response for draft undo. Non-success cases (expired, conflict, not found) are HTTP errors (410/409/404). */
export type DraftUndoResponse = { status: "reactivated"; draftId: string };

export type DraftUndoAcceptRequest = {
  draftId: string;
  writeId?: string;
};
