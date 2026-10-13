/**
 * Wire contracts for reviewing AI document drafts: the one list row, the preview, the operations a
 * change is made of, and every Apply and Discard command with its outcome.
 *
 * Vocabulary (D68): `draftId` is a `drafts` row (the Work's whole draft), `itemKey`
 * (`${draftId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * document's text branch never crosses the wire. `branchGeneration` is that branch's generation.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type { DraftCommandId, DraftId, DraftItemKey } from "../ids.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const DraftCommandIdSchema = z.string().uuid();

/** Why an item cannot be applied as-is: another live change collided with it. */
export type DraftItemConflict =
  | { code: "path_taken"; path: string }
  | { code: "rename_replaced"; livePath: string }
  | { code: "deleted_live" };

/** Freshness evidence a client echoes back on an item command. */
export type DraftItemTokens = {
  locationToken: string;
  liveTextToken: string | null;
  branchGenerationToken: string | null;
};

/**
 * One review item of the Work's active draft: a created or edited document, text or binary.
 * The list, Work counts and the open review all read this one row.
 */
export interface ThreadDraftListItem {
  /** The whole draft (a `drafts` row). */
  draftId: DraftId;
  /** `${draftId}:${documentId}`: the review identity for list rows, address, commands and queries. */
  itemKey: DraftItemKey;
  documentId: string;
  /**
   * The item's branch generation: it rises with each reset or refork, and the same `itemKey`
   * carries the next proposal at the higher generation. Null for an item with no branch (a created
   * image, or a create whose first text write has not happened).
   */
  branchGeneration: number | null;
  origin: "created" | "edited";
  /** Created and still hidden from the manuscript. */
  isNew: boolean;
  binary: boolean;
  /** `isNew || binary || deletedLive`: one change, settled by item Apply or Discard only. */
  wholeItem: boolean;
  documentName: string | null;
  /** The document URI's scheme and leading-slash path in the draft's view, independent of the Work. */
  contextLocation: Pick<ParsedContextUri, "scheme" | "path"> | null;
  /** The live URI when it differs from `contextLocation` (revealed, then moved live). */
  livePath: string | null;
  conflict: DraftItemConflict | null;
  tokens: DraftItemTokens;
  /** True while a staged batch holds the item: progress only, never a settlement signal. */
  settling: boolean;
  /** Chats with pending agent writes in this item, latest first. Candidates: a chat's writes may be overwritten. */
  actorThreads: { threadId: string; title: string | null }[];
  updatedAt: string;
}

export interface ThreadDraftListResponse {
  items: ThreadDraftListItem[];
}

type ActiveDraftPreviewBase = {
  status: "active";
  draftId: DraftId;
  itemKey: DraftItemKey;
  /** The branch generation (see `ThreadDraftListItem.branchGeneration`) that `reviewRoomName` and the tokens belong to. */
  branchGeneration: number;
  /** Hocuspocus room name for inline branch review; already generation-fenced. Opaque to the client. */
  reviewRoomName: string;
  liveRevisionToken: string;
  draftRevisionToken: string;
  /** The item as the server resolved it for this preview, whether or not it is listed. */
  item: ThreadDraftListItem;
};

export type DraftPreviewRefusal =
  | { status: "gone"; itemKey: DraftItemKey }
  /** `draftId` lets a corrupt item missing from the list still build its whole-item Discard. */
  | { status: "corrupt"; draftId: DraftId; itemKey: DraftItemKey; branchGeneration: number };

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | DraftPreviewRefusal;

/**
 * The change an operation is across branch generations: its part key, which a
 * re-fork keeps while it gives the row a new `operationId`. An operation with no
 * part key is only the row it is.
 */
export function operationKey(operation: Pick<ReviewOperation, "operationId" | "partKey">): string {
  return operation.partKey ?? `row:${operation.operationId}`;
}

export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  /** The journal row carrying this change in the item's current branch generation. Admission names rows; it is not continuity. */
  operationId: string;
  /**
   * The change's identity across branch generations: `<editId>:<ordinal>` of the
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
 * deleted block: the live block's own Yjs item, which the next generation of
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
// Every Apply and Discard carries a client `commandId`. One outcome matrix serves them all:
//   applied / discarded -> 200 (per-change and item results say whether the item closed)
//   held (5a)           -> per-item `held` inside an item or Apply-all result, or 409 on item Apply
//   stale / gone        -> 409 on Apply, 200 body on per-change commands; the review refreshes
//   pending             -> 202 `{ status: "pending", draftId, commandId }`; observe the command
//   blocked             -> observed `{ state: "blocked" }`, never a 200; terminal for the client
//   unknown (transport) -> resend the same `commandId` and body; the server deduplicates
// The client never infers a command's settlement from the list.

/** Which writer command a `commandId` was recorded for. */
export const DRAFT_COMMAND_KINDS = [
  "apply_items",
  "apply_changes",
  "discard_items",
  "discard_changes",
  "discard_draft",
] as const;
export type DraftCommandKind = (typeof DRAFT_COMMAND_KINDS)[number];

/** HTTP 409 code: the `commandId` was already used for a different command. */
export const DRAFT_COMMAND_CONFLICT_CODE = "command_conflict";
/** HTTP 404 code on observation: nothing committed under this `commandId`, so the client resends. */
export const DRAFT_COMMAND_UNKNOWN_CODE = "unknown_command";

/** Why a drafted item stays in review after Apply (5a). */
export type DraftHeldReason = { code: "path_taken"; path: string };
export type DraftApplyNote =
  | { code: "rename_replaced"; replacedPath: string; path: string }
  | { code: "restored"; path: string };
export type DraftApplyItemResult =
  | { itemKey: DraftItemKey; status: "applied"; notes: DraftApplyNote[] }
  | { itemKey: DraftItemKey; status: "held"; reason: DraftHeldReason };

/** 202 without a client command: the D40 write-mode switch stages its own Apply. */
export type DraftApplyPending = { status: "pending"; draftId: DraftId };
/** 202: the batch is staged and recovery is finishing it. Observe `commandId` for the result. */
export type DraftApplyPendingResponse = DraftApplyPending & { commandId: DraftCommandId };

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

// Item Apply and Discard: one whole item, by `itemKey`.

export type DraftApplyRequest = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  commandId: DraftCommandId;
} & Partial<DraftItemTokens>;
/** Item Apply's 200. `item` is the settled item's result (applied notes). */
export type DraftApplyResponse = {
  status: "applied";
  draftId: DraftId;
  itemKey: DraftItemKey;
  item: DraftApplyItemResult;
};
/** Item Apply: confirmed 200 or staged 202. */
export type DraftApplyHttpResponse = DraftApplyResponse | DraftApplyPendingResponse;
/** A held or stale item Apply answers 409 with this body. */
export type DraftApplyRefusalBody =
  | { status: "held"; draftId: DraftId; itemKey: DraftItemKey; reason: DraftHeldReason }
  | { status: "stale"; draftId: DraftId; itemKey: DraftItemKey };

export type DraftDiscardRefusalStatus = "stale" | "gone" | "whole_item" | "incomplete_class";

export type DraftDiscardResponse =
  | ({
      status: "discarded";
      draftId: DraftId;
      itemKey: DraftItemKey;
    } & DraftItemSettlement)
  | { status: DraftDiscardRefusalStatus; draftId: DraftId; itemKey: DraftItemKey };
/**
 * Item Discard sends no selection. Per-change Discard admits by class: `closureClassIds` with
 * `admissionTokens` over the clicked classes' closed rows and rich effect, and `memberPartKeys`
 * (immutable part keys, empty for fallback-only classes) that only classify an absent class.
 * Physical journal ids never cross the wire, and `operationIds` are not part of the request.
 */
export type DraftDiscardRequest = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  commandId: DraftCommandId;
  /** Required for per-change Discard; absent for item Discard. */
  liveRevisionToken?: string;
  draftRevisionToken?: string;
  /** Required for per-change Discard: stable server-vended class identities at click. */
  closureClassIds?: string[];
  /** Required for per-change Discard: unchanged closed-row and rich-effect evidence at click. */
  admissionTokens?: string[];
  /** Clicked immutable members classify a missing class, never authorize a replacement. */
  memberPartKeys?: string[];
};

// Per-change Apply: complete server-vended classes. Physical journal ids never cross the wire
// except as the preview's operation ids, which name the selected classes.

export type DraftApplyChangesRequest = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  commandId: DraftCommandId;
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};
export type DraftApplyChangesResponse =
  | ({
      status: "applied";
      draftId: DraftId;
      itemKey: DraftItemKey;
      operationIds: string[];
      closureClassIds: string[];
    } & DraftItemSettlement)
  | {
      status: "stale" | "gone" | "whole_item" | "incomplete_class";
      draftId: DraftId;
      itemKey: DraftItemKey;
    }
  | DraftApplyPendingResponse;

// Apply all and Discard all: one server command over the Work's whole draft.

export const DraftApplyItemRefSchema = z.object({
  itemKey: z.string().max(80),
  locationToken: z.string().max(40),
  liveTextToken: z.string().max(100).optional(),
  branchGenerationToken: z.string().max(40).optional(),
});
export type DraftApplyItemRef = z.infer<typeof DraftApplyItemRefSchema>;

export const DraftApplyAllRequestSchema = z.object({
  /** The whole draft the dock rendered (a drafts row; D68). */
  draftId: z.string().uuid(),
  commandId: DraftCommandIdSchema,
  /** Each item once: a selection is a set. */
  items: z
    .array(DraftApplyItemRefSchema)
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((item) => item.itemKey)).size === items.length, {
      message: "Each item can be applied once per request",
    }),
});
export type DraftApplyAllRequest = z.infer<typeof DraftApplyAllRequestSchema>;

/**
 * `completed` means the command settled, including selections whose items were all held. Apply never
 * closes the draft, so the result carries no draft closure.
 */
export type DraftApplyAllResponse =
  | DraftApplyPendingResponse
  | { status: "completed"; draftId: DraftId; items: DraftApplyItemResult[] }
  | { status: "stale"; draftId: DraftId; staleItemKeys: DraftItemKey[] }
  | { status: "gone"; draftId: DraftId };

export const DraftDiscardAllRequestSchema = z.object({
  /** A drafts row (D68), never a branch id. */
  draftId: z.string().uuid(),
  commandId: DraftCommandIdSchema,
});
export type DraftDiscardAllRequest = z.infer<typeof DraftDiscardAllRequestSchema>;
/** `discarded` closes the draft (the only wire signal of closure); `gone` names one that is not the Work's active draft. */
export type DraftDiscardAllResponse =
  | { status: "discarded"; draftId: DraftId }
  | { status: "gone"; draftId: DraftId };

// Observing a command: `GET …/works/:w/drafts/commands/:commandId`.

/** The terminal body of a command, exactly what its 200 carried. */
export type DraftCommandResult =
  | DraftApplyResponse
  | DraftApplyChangesResponse
  | DraftApplyAllResponse
  | DraftDiscardResponse
  | DraftDiscardAllResponse
  | DraftApplyRefusalBody;
/**
 * `pending` keeps the claim and polling; `done` settles it as the 200 would; `blocked` is terminal
 * (stop polling, show the failure on the item, never retry automatically). A missing command answers
 * 404 `unknown_command`: nothing committed, so the client resends.
 */
export type DraftCommandObservation =
  | { state: "pending" }
  | { state: "done"; result: DraftCommandResult }
  | { state: "blocked" };
