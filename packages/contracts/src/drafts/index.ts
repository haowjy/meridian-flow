/** JSON wire contracts for reviewing AI document drafts before they touch live documents. */
import type { DocumentId } from "../runtime/ids.js";

export type DraftReviewStatus = "active" | "accepting" | "applied" | "discarded";

export interface DraftReviewSummary {
  id: string;
  status: DraftReviewStatus;
  lastActorTurnId: string | null;
  updatedAt: string;
}

export interface ThreadDraftListItem {
  draftId: string;
  documentId: string;
  documentName: string | null;
  status: "active";
  lastActorTurnId: string | null;
  updatedAt: string;
}

export interface ThreadDraftListResponse {
  drafts: ThreadDraftListItem[];
}

export type DraftPreviewResponse =
  | {
      status: "active";
      draftId: string;
      live: string;
      preview: string;
      liveRevisionToken: number;
    }
  | { status: "gone"; live: string };

export const DRAFT_ACCEPT_TURN_KIND = "draft_accept";
export const DRAFT_ACCEPT_TURN_TEXT = "You accepted this draft";

export type DraftAcceptTurnRequestParams = {
  kind: typeof DRAFT_ACCEPT_TURN_KIND;
  draftId: string;
  documentId: DocumentId;
};

export function draftAcceptTurnRequestParams(input: {
  draftId: string;
  documentId: DocumentId;
}): DraftAcceptTurnRequestParams {
  return {
    kind: DRAFT_ACCEPT_TURN_KIND,
    draftId: input.draftId,
    documentId: input.documentId,
  };
}

export function isDraftAcceptTurnRequestParams(
  value: unknown,
): value is DraftAcceptTurnRequestParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === DRAFT_ACCEPT_TURN_KIND &&
    typeof record.draftId === "string" &&
    typeof record.documentId === "string"
  );
}

export type DraftAcceptResponse =
  | { status: "applied"; draftId: string; appliedUpdateSeq: number; acceptTurnId: string }
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
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
};

export type DraftRejectResponse = { status: "discarded"; draftId: string };

export type DraftRejectRequest = {
  draftId: string;
};
