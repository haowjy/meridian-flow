/**
 * Wire contracts for reviewing AI document drafts: the one list row, the preview, the operations a
 * change is made of, and every Apply and Discard command with its outcome.
 *
 * Vocabulary (D68): `branchId` is a `branches` row (the Work's whole branch), `itemKey`
 * (`${branchId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * document's text draft never crosses the wire. `draftGeneration` is that draft's generation.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type { BranchCommandId, BranchId, DraftItemKey } from "../ids.js";
import type { DocumentRemovalRecord } from "../protocol/document-removal.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const BranchCommandIdSchema = z.string().uuid();

/** Why an item cannot be applied as-is: another live change collided with it. */
export type DraftItemConflict = { code: "path_taken"; path: string } | { code: "deleted_live" };

/** Freshness evidence a client echoes back on an item command. */
export type DraftItemTokens = {
  locationToken: string;
  liveTextToken: string | null;
  draftGenerationToken: string | null;
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
  /**
   * The item's draft generation: it rises with each reset or refork, and the same `itemKey`
   * carries the next proposal at the higher generation. Null for an item with no text draft (a created
   * image, or a create whose first text write has not happened).
   */
  draftGeneration: number | null;
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
  /** True while a staged batch holds the item: progress only, never a settlement signal. */
  settling: boolean;
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

type ActiveDraftPreviewBase = {
  status: "active";
  branchId: BranchId;
  itemKey: DraftItemKey;
  /** The draft generation (see `ThreadDraftListItem.draftGeneration`) that `reviewRoomName` and the tokens belong to. */
  draftGeneration: number;
  /** Hocuspocus room name for inline draft review; already generation-fenced. Opaque to the client. */
  reviewRoomName: string;
  liveRevisionToken: string;
  draftRevisionToken: string;
  /** The item as the server resolved it for this preview, whether or not it is listed. */
  item: ThreadDraftListItem;
};

export type DraftPreviewRefusal =
  | { status: "gone"; itemKey: DraftItemKey }
  /** `branchId` lets a corrupt item missing from the list still build its whole-item Discard. */
  | { status: "corrupt"; branchId: BranchId; itemKey: DraftItemKey; draftGeneration: number };

export type DraftPreviewResponse =
  | (ActiveDraftPreviewBase & {
      operations: ReviewOperation[];
      hunks: ReviewHunk[];
    })
  | DraftPreviewRefusal;

/**
 * The change an operation is across draft generations: its part key, which a
 * re-fork keeps while it gives the row a new `operationId`. An operation with no
 * part key is only the row it is.
 */
export function operationKey(operation: Pick<ReviewOperation, "operationId" | "partKey">): string {
  return operation.partKey ?? `row:${operation.operationId}`;
}

export type ReviewOperationClassification = "rename" | "addition" | "removal" | "rewrite";

export interface ReviewOperation {
  /** The journal row carrying this change in the item's current draft generation. Admission names rows; it is not continuity. */
  operationId: string;
  /**
   * The change's identity across draft generations: `<editId>:<ordinal>` of the
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
//   pending             -> 202 `{ status: "pending", branchId, commandId }`; observe the command
//   blocked             -> observed `{ state: "blocked" }`, never a 200; terminal for the client
//   unknown (transport) -> resend the same `commandId` and body; the server deduplicates
// The client never infers a command's settlement from the list.

/** Which writer command a `commandId` was recorded for. */
export const BRANCH_COMMAND_KINDS = [
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

/**
 * Why Apply landed nothing for an item: its live path is taken (5a), or its live document
 * was removed, which Apply never revives (the removal closed the draft; `removal` is its
 * record, null if it could not be read).
 */
export type DraftHeldReason =
  | { code: "path_taken"; path: string }
  | { code: "deleted_live"; removal: DocumentRemovalRecord | null };
export type DraftApplyItemResult =
  | { itemKey: DraftItemKey; status: "applied" }
  | { itemKey: DraftItemKey; status: "held"; reason: DraftHeldReason };

/** 202 before the Apply has a client command to observe. */
export type DraftApplyPending = { status: "pending"; branchId: BranchId };
/** 202: the batch is staged and recovery is finishing it. Observe `commandId` for the result. */
export type DraftApplyPendingResponse = DraftApplyPending & { commandId: BranchCommandId };

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

// Item Apply and Discard: one whole item, by `itemKey`.

export type DraftApplyRequest = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  commandId: BranchCommandId;
} & Partial<DraftItemTokens>;
/** Item Apply's 200. `item` is the settled item's result. */
export type DraftApplyResponse = {
  status: "applied";
  branchId: BranchId;
  itemKey: DraftItemKey;
  item: DraftApplyItemResult;
};
/** Item Apply: confirmed 200 or staged 202. */
export type DraftApplyHttpResponse = DraftApplyResponse | DraftApplyPendingResponse;
/** A held or stale item Apply answers 409 with this body. */
export type DraftApplyRefusalBody =
  | { status: "held"; branchId: BranchId; itemKey: DraftItemKey; reason: DraftHeldReason }
  | { status: "stale"; branchId: BranchId; itemKey: DraftItemKey };

export type DraftDiscardRefusalStatus = "stale" | "gone" | "whole_item" | "incomplete_class";

export type DraftDiscardResponse =
  | ({
      status: "discarded";
      branchId: BranchId;
      itemKey: DraftItemKey;
    } & DraftItemSettlement)
  | { status: DraftDiscardRefusalStatus; branchId: BranchId; itemKey: DraftItemKey };
/**
 * The most `memberPartKeys` a per-change Discard carries. A writer's change holds one part per
 * keystroke frame, unbounded, so a client sends an even sample of a longer selection and says
 * so with `memberPartKeysComplete: false`. A sample proves a member survives; it cannot prove
 * none does.
 */
export const MAX_DISCARD_MEMBER_PART_KEYS = 500;

/**
 * Item Discard sends no selection. Per-change Discard admits by class: `closureClassIds` with
 * `admissionTokens` over the clicked classes' closed rows and rich effect, and `memberPartKeys`
 * (immutable part keys, empty for fallback-only classes) that only classify an absent class.
 * Physical journal ids never cross the wire, and `operationIds` are not part of the request.
 */
export type DraftDiscardRequest = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  commandId: BranchCommandId;
  /** Required for per-change Discard; absent for item Discard. */
  liveRevisionToken?: string;
  draftRevisionToken?: string;
  /** Required for per-change Discard: stable server-vended class identities at click. */
  closureClassIds?: string[];
  /** Required for per-change Discard: unchanged closed-row and rich-effect evidence at click. */
  admissionTokens?: string[];
  /** Clicked immutable members classify a missing class, never authorize a replacement. */
  memberPartKeys?: string[];
  /**
   * Required for per-change Discard: whether `memberPartKeys` lists every clicked member. A
   * missing class with no listed survivor is `gone` only when this is true, `stale` otherwise.
   */
  memberPartKeysComplete?: boolean;
};

// Per-change Apply: complete server-vended classes. Physical journal ids never cross the wire
// except as the preview's operation ids, which name the selected classes.

export type DraftApplyChangesRequest = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  commandId: BranchCommandId;
  operationIds: string[];
  liveRevisionToken: string;
  draftRevisionToken: string;
};
export type DraftApplyChangesResponse =
  | ({
      status: "applied";
      branchId: BranchId;
      itemKey: DraftItemKey;
      operationIds: string[];
      closureClassIds: string[];
    } & DraftItemSettlement)
  | {
      status: "stale" | "gone" | "whole_item" | "incomplete_class";
      branchId: BranchId;
      itemKey: DraftItemKey;
    }
  | DraftApplyPendingResponse;

// Apply all and Discard all: one server command over the Work's whole branch.

export const DraftApplyItemRefSchema = z.object({
  itemKey: z.string().max(80),
  locationToken: z.string().max(40),
  liveTextToken: z.string().max(100).optional(),
  draftGenerationToken: z.string().max(40).optional(),
});

export const BranchApplyAllRequestSchema = z.object({
  /** The whole branch the dock rendered (a `branches` row; D68). */
  branchId: z.string().uuid(),
  commandId: BranchCommandIdSchema,
  /** Each item once: a selection is a set. */
  items: z
    .array(DraftApplyItemRefSchema)
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((item) => item.itemKey)).size === items.length, {
      message: "Each item can be applied once per request",
    }),
});
export type BranchApplyAllRequest = z.infer<typeof BranchApplyAllRequestSchema>;

/**
 * `completed` means the command settled, including selections whose items were all held. Apply never
 * closes the branch, so the result carries no branch closure.
 */
export type BranchApplyAllResponse =
  | DraftApplyPendingResponse
  | { status: "completed"; branchId: BranchId; items: DraftApplyItemResult[] }
  | { status: "stale"; branchId: BranchId; staleItemKeys: DraftItemKey[] }
  | { status: "gone"; branchId: BranchId };

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
export type BranchCommandResult =
  | DraftApplyResponse
  | DraftApplyChangesResponse
  | BranchApplyAllResponse
  | DraftDiscardResponse
  | BranchDiscardAllResponse
  | DraftApplyRefusalBody;
/**
 * `pending` keeps the claim and polling; `done` settles it as the 200 would; `blocked` is terminal
 * (stop polling, show the failure on the item, never retry automatically). A missing command answers
 * 404 `unknown_command`: nothing committed, so the client resends.
 */
export type BranchCommandObservation =
  | { state: "pending" }
  | { state: "done"; result: BranchCommandResult }
  | { state: "blocked" };
