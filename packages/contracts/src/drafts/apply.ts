/**
 * Wire contracts for the whole-draft review list items, Apply and Discard all (foundation
 * contract §11.6, §12.3, §13.4). Additive in type and meaning (F14): today's `drafts` list, preview and
 * per-document Apply keep their fields; new information rides on new fields with D68
 * names (`draftId` is a drafts row, `draftBranchId` one document's branch).
 */
import { z } from "zod";

/** One review item: a created or edited document in the Work's draft. */
export type DraftReviewItemWire = {
  /** The whole draft (a drafts row). */
  draftId: string;
  /** `${draftId}:${documentId}`: the one key for every item, text or binary. */
  itemKey: string;
  documentId: string;
  /** The per-document branch; null for a created image. */
  draftBranchId: string | null;
  origin: "created" | "edited";
  /** Created and still hidden from the manuscript. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** The canonical URI in the draft's view (the last address for a document deleted live). */
  path: string | null;
  /** The live URI when it differs from `path` (revealed, then moved live). */
  livePath: string | null;
  conflict:
    | { code: "path_taken"; path: string }
    | { code: "rename_replaced"; livePath: string }
    | { code: "deleted_live" }
    | null;
  locationToken: string;
  liveTextToken: string | null;
  branchGenerationToken: string | null;
};

/** Additive on the list response: `{ drafts }` stays as it is and gains `items`. */
export type DraftListResponseAdditions = { items: DraftReviewItemWire[] };
/** Additive on the preview response. */
export type DraftPreviewAdditions = { item: DraftReviewItemWire };

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

export type DraftHeldReason = { code: "path_taken"; path: string };
export type DraftApplyNote =
  | { code: "rename_replaced"; replacedPath: string; path: string }
  | { code: "restored"; path: string };
export type DraftApplyItemResult =
  | { itemKey: string; status: "applied"; notes: DraftApplyNote[] }
  | { itemKey: string; status: "held"; reason: DraftHeldReason };
/** 202: the batch is staged and recovery is finishing it (F22, F27). `draftId` names the whole draft. */
export type DraftApplyPendingResponse = { status: "pending"; draftId: string };
export type DraftApplyAllResponse =
  | DraftApplyPendingResponse
  | { status: "applied"; draftId: string; draftClosed: boolean; items: DraftApplyItemResult[] }
  | { status: "stale"; draftId: string; staleItemKeys: string[] }
  | { status: "gone"; draftId: string };

/** Optional additive tokens on the legacy per-document Apply request. */
export const DraftApplyTokensSchema = DraftApplyItemRefSchema.omit({ itemKey: true }).partial();
export type DraftApplyTokens = z.infer<typeof DraftApplyTokensSchema>;
/** The legacy per-document Apply's 200 gains the item's result. */
export type DraftApplyResponseAdditions = { item: DraftApplyItemResult };
/** Per-document Apply: confirmed 200 or staged 202. */
export type DraftApplyHttpResponse =
  | (import("./review.js").DraftApplyResponse & DraftApplyResponseAdditions)
  | DraftApplyPendingResponse;
/** A held or stale per-document Apply answers 409 with this body. */
export type DraftApplyRefusalBody =
  | { status: "held"; draftId: string; reason: DraftHeldReason }
  | { status: "stale"; draftId: string };

/** Discard all (contract §12.3): the whole draft the dock rendered, one server command. */
export const DraftDiscardAllRequestSchema = z.object({
  /** A drafts row (D68), never a branch id. */
  draftId: z.string().uuid(),
});
export type DraftDiscardAllRequest = z.infer<typeof DraftDiscardAllRequestSchema>;
/** A whole Discard always closes the draft; `gone` names one that isn't the Work's active draft. */
export type DraftDiscardAllResponse =
  | { status: "discarded"; draftId: string; draftClosed: true }
  | { status: "gone"; draftId: string };
