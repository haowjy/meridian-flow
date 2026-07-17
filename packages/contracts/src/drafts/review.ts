export type WIdRange = { min: number; max: number };

/** Wire view-models for listing and reviewing AI document drafts. */

export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  documentName: string | null;
  contextPath: string | null;
  status: "active" | "closed";
  lastActorTurnId: string | null;
  updatedAt: string;
  appliedAt: string | null;
  discardedAt: string | null;
  partialAcceptedOperationCount?: number | null;
  proposedOperationCount?: number | null;
  wordsAdded: number | null;
  wordsRemoved: number | null;
  /**
   * the draft creates a document that does not yet exist in the
   * writer's live project (spec §5.5) — empty live root, no prior push_lineage.
   * Drives the dock row `New` badge + additions-only stats and the review
   * card's `New document` / `Create` variant. Derived server-side from the
   * branching model; consumed here. Absent/false = edit of a live document.
   */
  isNewDocument?: boolean;
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
  /**
   * mirrors `ThreadDraftListItem.isNewDocument` (spec §5.5) so the
   * open review can render the all-additions `New document` / `Create` card
   * variant without a second lookup. Produced by the server preview builder.
   */
  isNewDocument?: boolean;
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
  /**
   * Server-vended closure-class id. Every operation in one journal-backed
   * hunk-sharing closure class carries the same id; the review surface renders
   * one proposal card per distinct id.
   */
  closureClassId?: string;
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
  /** Stable block hashes touched by this hunk, used to mark push conflicts. */
  blockHashes?: string[];
  anchor: {
    relStart: string;
    relEnd: string;
  };
  /**
   * set by the S4 diff pipeline (spec §6.2.1) when this hunk's branch
   * struct ids interleave with live struct ids in the same text node — a CRDT
   * merge artifact, not an authorship state. Drives the neutral dashed "Merged"
   * treatment (manuscript decoration + dock verb). Absent/false = ordinary
   * hued authorship hunk. Produced by the server/contract lane; consumed here.
   */
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

export type DraftAcceptResponse =
  | { status: "applied"; draftId?: string; branchId?: string }
  | { status: "partial_applied"; draftId: string; writeId: string }
  | DraftApplyRefusal
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number };

export type DraftApplyConflict = {
  blockId: string;
  journalIds: number[];
  draftBaseUpdateSeq: number;
  effect: "overwrite" | "delete" | "resurrection";
  evidence: "human_live_change" | "human_live_deletion" | "ambiguous_protected_divergence";
  captured: {
    base: string | null;
    live: string | null;
    proposed: string | null;
  };
  why: string;
};

/** Manual Apply refusal. A review click never changes this evidence. */
export type DraftApplyRefusal = {
  status: "concurrent_conflict";
  reason: "draft_base_divergence";
  conflictedBlocks: string[];
  conflicts: DraftApplyConflict[];
};

type DraftAcceptRequestBase = {
  draftRevisionToken: number;
  /** Exact operation set shown by the preview this Apply confirms. */
  operationIds: string[];
};

export type DraftAcceptRequest =
  | (DraftAcceptRequestBase & { draftId: string; branchId?: never })
  | (DraftAcceptRequestBase & { branchId: string; draftId?: never });

export type DraftRejectResponse = { status: "discarded"; draftId?: string; branchId?: string };
export type DraftRejectRequest =
  | { draftId: string; branchId?: never; operationIds?: string[] }
  | { branchId: string; draftId?: never; operationIds?: string[] };
export type DraftUndoResponse = { status: "not_found"; draftId: string };
export type DraftUndoAcceptRequest = { draftId: string; writeId?: string };
