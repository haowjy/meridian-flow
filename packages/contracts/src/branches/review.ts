/**
 * Wire contracts for reviewing AI document drafts: the one list row, the preview, the operations a
 * change is made of, and every Apply and Discard command with its outcome.
 *
 * Vocabulary (D68): `branchId` is a `branches` row (the Work's whole branch), `itemKey`
 * (`${branchId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * document's text draft never crosses the wire. `hasDraft` reports only its existence.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type { BranchCommandId, BranchId, DraftItemKey } from "../ids.js";
import type { DocumentRemovalRecord } from "../protocol/document-removal.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const BranchCommandIdSchema = z.string().uuid();

/** JSON form of the kernel's SpanPatch; PM nodes cross the wire as node JSON. */
export type ApplySpanPatch = {
  base: { from: number; to: number };
  draft: { from: number; to: number };
  blocks: { type: string; [key: string]: unknown }[];
};

/** One frozen click, sent in the draft's FIFO. No revision or generation fence. */
export type ApplyClick = {
  commandId: BranchCommandId;
  /** Base64 of Y.encodeSnapshotV2(room snapshot). Omitted only for a no-room creation reveal. */
  snapshot?: string;
  baseViewDelta: ApplySpanPatch[];
  groupIds: string[];
};

export type ApplyClickRefusalReason =
  | "unsynced"
  | "malformed"
  | "work_archived"
  | "work_deleted"
  | "not_found"
  | "forbidden";

export type ApplyClickResult =
  | { status: "applied"; commandId: BranchCommandId; overrode?: number }
  | { status: "closed"; commandId: BranchCommandId; removal?: DocumentRemovalRecord }
  | { status: "refused"; commandId: BranchCommandId; reason: ApplyClickRefusalReason };

export type ApplyClickAnswer =
  | ApplyClickResult
  | { status: "pending" | "conflict"; commandId: BranchCommandId };
export type ApplyClickObservation =
  | ApplyClickAnswer
  | { status: "none"; commandId: BranchCommandId };

/** The journal also retains historical commands until the settlement paths are removed. */
export type StoredBranchCommandResult = BranchCommandResult | ApplyClickResult;

/** Why an item cannot be applied as-is: another live change collided with it. */
export type DraftItemConflict = { code: "path_taken"; path: string } | { code: "deleted_live" };

/** Freshness evidence a client echoes back on an item command. */
export type DraftItemTokens = {
  locationToken: string;
  liveTextToken: string | null;
};

/**
 * One review item of the Work's active branch: a created or edited document, text or binary.
 * The list, Work counts and the open review all read this one row.
 */
export interface ThreadDraftListItem {
  /** The whole branch (a `branches` row). */
  branchId: BranchId;
  /** `${branchId}:${documentId}`: the review identity for list rows, address, commands and queries. */
  itemKey: DraftItemKey;
  documentId: string;
  /** Whether the item has a text draft (an empty create or image may not). */
  hasDraft: boolean;
  origin: "created" | "edited";
  /** Created and still hidden from the manuscript. */
  isNew: boolean;
  binary: boolean;
  /** `isNew || binary || deletedLive`: one change, settled by item Apply or Discard only. */
  wholeItem: boolean;
  documentName: string | null;
  /** The document URI's scheme and leading-slash path in the branch's view, independent of the Work. */
  contextLocation: Pick<ParsedContextUri, "scheme" | "path"> | null;
  conflict: DraftItemConflict | null;
  tokens: DraftItemTokens;
  /** Chats with pending agent writes in this item, latest first. Candidates: a chat's writes may be overwritten. */
  actorThreads: { threadId: string; title: string | null }[];
  updatedAt: string;
}

/**
 * One document's draft in an active branch, for the hint on an open document. The branch is
 * named by its own `label`; `originWorkId` is the branch's origin Work, which today's review
 * address still needs and a branch without an origin Work will not have.
 */
export interface DocumentDraftHint {
  branchId: BranchId;
  /** The draft's review identity for the document, as in the list. */
  itemKey: DraftItemKey;
  /** How the branch is named to the writer; null when it has no name (the client words that). */
  label: string | null;
  originWorkId: string | null;
}

export interface DocumentDraftHintsResponse {
  items: DocumentDraftHint[];
}

export interface ThreadDraftListResponse {
  items: ThreadDraftListItem[];
}

/** SQL-only addressed lookup; no text room is loaded or created. */
export type DraftMetadataResponse =
  | { status: "active"; draftId: string; reviewRoomName: string; item: ThreadDraftListItem }
  | { status: "gone" };

type ActiveDraftPreviewBase = {
  status: "active";
  branchId: BranchId;
  itemKey: DraftItemKey;
  /** Hocuspocus room name for inline draft review; stable for the draft lifetime. Opaque to the client. */
  reviewRoomName: string;
  liveRevisionToken: string;
  draftRevisionToken: string;
  /** The item as the server resolved it for this preview, whether or not it is listed. */
  item: ThreadDraftListItem;
};

export type DraftPreviewRefusal =
  | { status: "gone"; itemKey: DraftItemKey }
  /** `branchId` lets a corrupt item missing from the list still build its whole-item Discard. */
  | { status: "corrupt"; branchId: BranchId; itemKey: DraftItemKey };

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | DraftPreviewRefusal;

/**
 * The immutable receipt identity of a change: its part key. An operation with no
 * part key is only the row it is.
 */
export function operationKey(operation: Pick<ReviewOperation, "operationId" | "partKey">): string {
  return operation.partKey ?? `row:${operation.operationId}`;
}

export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  /** The journal row carrying this change in the item's draft. Admission names rows; it is not continuity. */
  operationId: string;
  /**
   * The change's immutable identity: `<editId>:<ordinal>` of the
   * recorded edit part the row carries. A re-fork re-journals surviving rows
   * under new `operationId`s with the same part key, so this is what a queued
   * click, a focus or a held failure finds its change by. Absent for a row that
   * records no edit part (manifest and reversal rows): it only matches itself.
   */
  partKey?: string;
  actorTurnId?: string;
  /** Originating chat and its title at preview time. Agent operations only. */
  actorThreadId?: string;
  actorThreadTitle?: string;
  /** The tool call in that chat's turn that made the write. Absent for older writes. */
  actorToolCallId?: string;
  /**
   * Server-vended closure-class id. Every operation in one journal-backed
   * dependency-closed review class carries the same id; the review surface renders
   * one change per distinct id.
   */
  closureClassId: string;
  /** Server evidence for this class's complete closed journal membership and rich effect. */
  admissionToken: string;
  /** False when this class contains incomplete attribution; omit per-change actions. */
  canApplyOrDiscard?: boolean;
  kind: "agent" | "writer";
  classification: ReviewOperationClassification;
  beforeExcerpt?: string;
  afterExcerpt?: string;
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
  /** Render without inventing an author; only document-level disposition is available. */
  unclassified?: boolean;
  anchor: {
    relStart: string;
    relEnd: string;
  };
  /** True when surviving inserted text has both insertion boundaries in context removed by the other author. Mixed author spans alone are not a merge artifact. */
  mergeArtifact?: boolean;
};

/** UTF-16 offsets into deletedText; ordered, disjoint spans cover that text. */
export type ReviewDeletedSpan = {
  from: number;
  to: number;
  deletedBy: "agent" | "writer";
};

export type ReviewTextHunk = ReviewHunkBase & {
  kind: "text";
  spans: ReviewHunkSpan[];
  /**
   * The hunk's full insertion, including when it sits beside a removal; never only the part an
   * author is attributed. List excerpts render it whether attributed or unclassified.
   */
  insertedText?: string;
  deletedText?: string;
  deletedSpans?: ReviewDeletedSpan[];
  /** Set when `deletedText` is a whole live block taken out: that block's `blockItemKey`. */
  deletedBlockId?: string;
};

export type ReviewFormattingChange =
  | { kind: "mark"; mark: string; change: "added" | "removed" | "changed"; text: string }
  | { kind: "heading"; before: number; after: number }
  | { kind: "block"; before: string; after: string }
  | { kind: "attributes" }
  | { kind: "structure" };

/**
 * A block as the review shows it. `blockId` (a `blockItemKey`) is set on a
 * deleted block: the live block's own Yjs item, which later versions of
 * the draft still has when the deletion is discarded.
 */
export type ReviewBlockDisplay = { type: string; display: string; blockId?: string };

/** The Yjs item identity of a top-level block, as the wire and the page's copies of it write it. */
export function blockItemKey(id: { clientID: number; clock: number }): string {
  return `${id.clientID}:${id.clock}`;
}

export type ReviewBlockHunk = ReviewHunkBase & {
  kind: "block";
  /** Semantic formatting facts; clients own localized change-list wording. */
  formatting?: ReviewFormattingChange[];
  insertedBlock?: ReviewBlockDisplay;
  deletedBlock?: ReviewBlockDisplay;
};

export type ReviewHunk = ReviewTextHunk | ReviewBlockHunk;

// --- Commands and outcomes (contract §4.5, §4.6) ---------------------------------------------
//
// Discard commands replay their stored outcome by command id; pending claims answer 202.
// Frozen Apply clicks have their own answer/observation contract below.

/** Which writer command a `commandId` was recorded for. */
export const BRANCH_COMMAND_KINDS = [
  "apply_click",
  "apply_items",
  "apply_changes",
  "discard_items",
  "discard_changes",
  "discard_branch",
] as const;
export type BranchCommandKind = (typeof BRANCH_COMMAND_KINDS)[number];

/** HTTP 409 code: the `commandId` was already used for a different command. */
export const BRANCH_COMMAND_CONFLICT_CODE = "command_conflict";
/** HTTP 404 code on observation: nothing committed under this `commandId`, so the client resends. */
export const BRANCH_COMMAND_UNKNOWN_CODE = "unknown_command";

/** A claim is pending; observe its command id for the committed result. */
export type BranchCommandPending = { status: "pending"; branchId: BranchId };
/** 202: a command claim exists but has not yet supplied its result. */
export type BranchCommandPendingResponse = BranchCommandPending & { commandId: BranchCommandId };

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

export type DraftDiscardRefusalStatus = "stale" | "gone" | "whole_item" | "incomplete_class";

export type DraftDiscardResponse =
  | ({
      status: "discarded";
      branchId: BranchId;
      itemKey: DraftItemKey;
    } & DraftItemSettlement)
  | { status: DraftDiscardRefusalStatus; branchId: BranchId; itemKey: DraftItemKey };

/** End one still-hidden creation's branch use; edited-text Discard is browser-local. */
export type DraftDiscardRequest = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  commandId: BranchCommandId;
};

export const BranchDiscardAllRequestSchema = z.object({
  /** A `branches` row id (D68), never a per-document draft id. */
  branchId: z.string().uuid(),
  commandId: BranchCommandIdSchema,
});
export type BranchDiscardAllRequest = z.infer<typeof BranchDiscardAllRequestSchema>;
/** `discarded` closes the branch (the only wire signal of closure); `gone` names one that is not the Work's active branch. */
export type BranchDiscardAllResponse =
  | { status: "discarded"; branchId: BranchId }
  | { status: "gone"; branchId: BranchId };

// Observing a command: `GET …/works/:w/branches/commands/:commandId`.

/** The terminal body of a command, exactly what its 200 carried. */
export type BranchCommandResult = DraftDiscardResponse | BranchDiscardAllResponse;
/**
 * `pending` keeps the claim; `done` returns the committed result. A missing command answers
 * 404 `unknown_command`: nothing committed, so the client resends.
 */
export type BranchCommandObservation =
  | { state: "pending" }
  | { state: "done"; result: BranchCommandResult };
