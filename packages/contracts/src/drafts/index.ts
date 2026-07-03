/** JSON wire contracts for reviewing AI document drafts before they touch live documents. */
import type { DocumentId } from "../runtime/ids.js";

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
export type DraftReviewFallbackReason =
  | "rewrite_threshold"
  | "hunk_density"
  | "block_churn"
  | "unsupported_node_type";

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

const DRAFT_ACCEPT_TURN_KIND = "draft_accept";
const DRAFT_REJECT_TURN_KIND = "draft_reject";
export const DRAFT_ACCEPT_TURN_TEXT = "You accepted this draft";

export function draftAcceptTurnRequestParams(input: {
  draftId: string;
  documentId: DocumentId;
  documentName?: string | null;
  wIdRange?: WIdRange | null;
}) {
  return {
    kind: DRAFT_ACCEPT_TURN_KIND,
    draftId: input.draftId,
    documentId: input.documentId,
    documentName: input.documentName ?? null,
    wIdRange: input.wIdRange ?? null,
  };
}

export function isDraftAcceptTurnRequestParams(
  value: unknown,
): value is ReturnType<typeof draftAcceptTurnRequestParams> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === DRAFT_ACCEPT_TURN_KIND &&
    typeof record.draftId === "string" &&
    typeof record.documentId === "string"
  );
}

export function draftRejectTurnRequestParams(input: {
  draftId: string;
  documentId: DocumentId;
  documentName?: string | null;
  wIdRange?: WIdRange | null;
}) {
  return {
    kind: DRAFT_REJECT_TURN_KIND,
    draftId: input.draftId,
    documentId: input.documentId,
    documentName: input.documentName ?? null,
    wIdRange: input.wIdRange ?? null,
  };
}

export function isDraftRejectTurnRequestParams(
  value: unknown,
): value is ReturnType<typeof draftRejectTurnRequestParams> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === DRAFT_REJECT_TURN_KIND &&
    typeof record.draftId === "string" &&
    typeof record.documentId === "string"
  );
}

// Writer-facing transcript text. Internal write ids (wIdRange) stay in the
// structured turn params only — never in the prose a writer reads.
export function formatDraftAcceptTurnText(documentName: string | null): string {
  const docPart = documentName ? ` to "${documentName}"` : "";
  return `Applied AI draft${docPart}`;
}

export function formatDraftRejectTurnText(documentName: string | null): string {
  const docPart = documentName ? ` for "${documentName}"` : "";
  return `Discarded AI draft${docPart}`;
}

export type DraftAcceptResponse =
  | { status: "applied"; draftId: string; appliedUpdateSeq: number; acceptTurnId: string }
  | { status: "stale_draft"; draftId: string; draftRevisionToken: number }
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
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
};

export type DraftRejectResponse = { status: "discarded"; draftId: string; rejectTurnId: string };

export type DraftRejectRequest = {
  draftId: string;
};

/** 1-day retention window for draft undo operations. */
export const DRAFT_UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Success response for draft undo. Non-success cases (expired, conflict, not found) are HTTP errors (410/409/404). */
export type DraftUndoResponse = { status: "reactivated"; draftId: string };
