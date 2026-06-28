/** JSON wire contracts for reviewing AI document drafts before they touch live documents. */

export type DraftReviewStatus = "active" | "applied" | "discarded";

export interface DraftReviewSummary {
  id: string;
  status: DraftReviewStatus;
  lastActorTurnId: string | null;
  updatedAt: string;
}

export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  status: "active";
  lastActorTurnId: string | null;
  updatedAt: string;
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

export interface DraftPreviewResponse {
  draft: DraftReviewSummary | null;
  live: string;
  /** Current live markdown plus active draft deltas. Omitted when no active draft exists. */
  preview?: string;
}

export type DraftAcceptResponse =
  | { status: "applied"; draftId: string; appliedUpdateSeq: number }
  | { status: "discarded"; draftId: string; appliedUpdateSeq?: null }
  | { status: "not_found"; draftId?: null; appliedUpdateSeq?: null };

export type DraftRejectResponse =
  | { status: "discarded"; draftId: string }
  | { status: "not_found"; draftId?: null };
