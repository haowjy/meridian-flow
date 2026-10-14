/**
 * Wire contracts for reviewing AI document drafts: the one list row, the preview, the operations a
 * change is made of, and every Apply and Discard command with its outcome.
 *
 * Vocabulary (D68): `draftId` is a `drafts` row (the Work's whole draft), `itemKey`
 * (`${draftId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * document's text branch never crosses the wire.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type { DraftCommandId, DraftId, DraftItemKey } from "../ids.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const DraftCommandIdSchema = z.string().uuid();

/** Why an item cannot be applied as-is: another live change collided with it. */
export type DraftItemConflict = { code: "path_taken"; path: string } | { code: "deleted_live" };

/** Freshness evidence a client echoes back on an item command. */
export type DraftItemTokens = { locationToken: string };

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
  origin: "created" | "edited";
  /** Created and still hidden from the manuscript. */
  isNew: boolean;
  binary: boolean;
  /** `isNew || binary || deletedLive`: one change, settled by item Apply or Discard only. */
  wholeItem: boolean;
  documentName: string | null;
  /** The document URI's scheme and leading-slash path in the draft's view, independent of the Work. */
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
 * One active draft with changes to a document, for the hint on an open document. A draft is
 * named by its own `label`; `originWorkId` is where it came from, which today's review
 * address still needs and a draft without a Work will not have.
 */
export interface DocumentDraftHint {
  draftId: DraftId;
  /** The draft's review identity for the document, as in the list. */
  itemKey: DraftItemKey;
  /** How the draft is named to the writer; null when it has no name (the client words that). */
  label: string | null;
  originWorkId: string | null;
}

export interface DocumentDraftHintsResponse {
  items: DocumentDraftHint[];
}

export interface ThreadDraftListResponse {
  items: ThreadDraftListItem[];
}

export type ReviewFormattingChange =
  | { kind: "mark"; mark: string; change: "added" | "removed" | "changed"; text: string }
  | { kind: "heading"; before: number; after: number }
  | { kind: "block"; before: string; after: string }
  | { kind: "attributes" }
  | { kind: "structure" };

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
export type DraftApplyNote = { code: "restored"; path: string };
/** 202 before the Apply has a client command to observe. */
export type DraftApplyPending = { status: "pending"; draftId: DraftId };
/** 202: the batch is staged and recovery is finishing it. Observe `commandId` for the result. */
export type DraftApplyPendingResponse = DraftApplyPending & { commandId: DraftCommandId };

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

// Observing a command: `GET …/works/:w/drafts/commands/:commandId`.

/** `discarded` closes the draft (the only wire signal of closure); `gone` names one that is not the Work's active draft. */
export type DraftDiscardAllResponse =
  | { status: "discarded"; draftId: DraftId }
  | { status: "gone"; draftId: DraftId };

/**
 * `pending` keeps the claim and polling; `done` settles it as the 200 would; `blocked` is terminal
 * (stop polling, show the failure on the item, never retry automatically). A missing command answers
 * 404 `unknown_command`: nothing committed, so the client resends.
 */
export type DraftCommandObservation =
  | { state: "pending" }
  | { state: "done"; result: DraftCommandOutcome }
  | { state: "blocked" };

// --- The content-Apply contract (re-landing contract §1.2) -----------------------------------
//
// Beside the types above under names they don't use. The server's producers and routes switch to
// these, then the client, and the lane that removes the last consumer of a type above deletes it.

export type DraftOverride = { live: string; applied: string };

/**
 * Why an item's Apply failed. No Apply content and no tree effect committed for it. A catch-up rebase that
 * succeeded before the failure stays committed (it is the branch's own durable catch-up), so the draft may read newer.
 */
export type DraftApplyFailure =
  | "settlement_unfinished" // an earlier batch with a member on this document is pending or blocked
  | "base_uninitialized" // the text branch has no base to compare with
  | "merge_failed"; // the catch-up rebase or the content plan threw

/** An outcome decided at staging, before anything reaches live. Stored in the draft_tree payload. */
export type DraftDecidedOutcome =
  | { itemKey: DraftItemKey; status: "already_live" }
  | { itemKey: DraftItemKey; status: "not_found" } // the snapshot or a named change can't be rebuilt
  | { itemKey: DraftItemKey; status: "failed"; reason: DraftApplyFailure };

/** One item's outcome inside any Apply. */
export type DraftItemOutcome =
  | ({
      itemKey: DraftItemKey;
      status: "applied";
      notes: DraftApplyNote[];
      /** Live text the merge replaced; empty when nothing overlapped. */
      overrode: DraftOverride[];
      /** The text branch still differs from its base after this Apply. */
      hasChanges: boolean;
    } & DraftItemSettlement)
  | { itemKey: DraftItemKey; status: "already_live"; hasChanges: boolean }
  | { itemKey: DraftItemKey; status: "held"; reason: DraftHeldReason }
  | Exclude<DraftDecidedOutcome, { status: "already_live" }>;

/** Both item routes (`apply`, `apply-changes`): the body of the 200, the 409/404, and of observation. */
export type DraftItemApplyResult =
  | ({ draftId: DraftId } & Extract<DraftItemOutcome, { status: "applied" | "already_live" }>) // 200
  | ({ draftId: DraftId } & Extract<DraftItemOutcome, { status: "held" | "not_found" | "failed" }>) // 409
  | { status: "stale" | "whole_item"; draftId: DraftId; itemKey: DraftItemKey } // 409
  | { status: "gone"; draftId: DraftId; itemKey: DraftItemKey }; // 404

/** Apply all. Per-item `stale` and `gone` don't exist: an unaddressable item makes the command `stale`. */
export type DraftApplyAllResult =
  | { status: "completed"; draftId: DraftId; items: DraftItemOutcome[] }
  | { status: "stale"; draftId: DraftId; staleItemKeys: DraftItemKey[] }
  | { status: "gone"; draftId: DraftId };

/** Item Discard always closes the item. */
export type DraftItemDiscardResult =
  | {
      status: "discarded";
      draftId: DraftId;
      itemKey: DraftItemKey;
      itemClosed: true;
      itemDisposition: "discarded";
    }
  | { status: "gone"; draftId: DraftId; itemKey: DraftItemKey };

/** What observation's `done.result` holds; the 2xx/4xx bodies are the same JSON. */
export type DraftCommandOutcome =
  | DraftItemApplyResult
  | DraftApplyAllResult
  | DraftItemDiscardResult
  | DraftDiscardAllResponse;

/**
 * `GET documents/:documentId/draft?itemKey=` (contract §3.2): where to open one item and whether it has
 * changes. It answers for every addressable item, listed or not; a 404 `{ code: "gone" }` means the item is
 * closed. The review itself is computed in the browser from `roomName`, which the client never builds or parses.
 */
export type DraftItemMeta =
  | {
      kind: "text";
      draftId: DraftId;
      itemKey: DraftItemKey;
      documentId: string;
      roomName: string;
      isNew: boolean;
      wholeItem: boolean;
      hasChanges: boolean;
    }
  | {
      /** A created image or blank create with no text branch: no room; only item-level actions exist. */
      kind: "branchless";
      draftId: DraftId;
      itemKey: DraftItemKey;
      documentId: string;
      isNew: boolean;
      wholeItem: true;
      hasChanges: false;
    };

// Strict command bodies. Unknown fields answer 400, so an old tab's per-change Discard can never
// be read as item Discard. Request types are the schemas' inference.

/** Base64 `Y.snapshot` of the text branch's room at the review frame the writer acted on. */
const SnapshotSchema = z.string().max(64 * 1024);
const ItemBody = {
  draftId: z.string().uuid(),
  itemKey: z.string().max(80),
  commandId: DraftCommandIdSchema,
};

export const DraftApplyChangesBodySchema = z
  .object({
    ...ItemBody,
    changeIds: z.array(z.string().max(200)).min(1).max(500),
    snapshot: SnapshotSchema,
    locationToken: z.string().max(40).optional(),
  })
  .strict();
export type DraftApplyChangesBody = z.infer<typeof DraftApplyChangesBodySchema>;

export const DraftApplyItemBodySchema = z
  .object({
    ...ItemBody,
    snapshot: SnapshotSchema.optional(),
    locationToken: z.string().max(40).optional(),
  })
  .strict();
export type DraftApplyItemBody = z.infer<typeof DraftApplyItemBodySchema>;

export const DraftApplyAllBodySchema = z
  .object({
    draftId: z.string().uuid(),
    commandId: DraftCommandIdSchema,
    /** Each item once: a selection is a set. */
    items: z
      .array(
        z
          .object({
            itemKey: z.string().max(80),
            locationToken: z.string().max(40),
            snapshot: SnapshotSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .refine((items) => new Set(items.map((item) => item.itemKey)).size === items.length, {
        message: "Each item can be applied once per request",
      }),
  })
  .strict();
export type DraftApplyAllBody = z.infer<typeof DraftApplyAllBodySchema>;

export const DraftItemDiscardBodySchema = z.object(ItemBody).strict();
export type DraftItemDiscardBody = z.infer<typeof DraftItemDiscardBodySchema>;

export const DraftDiscardAllBodySchema = z
  .object({ draftId: z.string().uuid(), commandId: DraftCommandIdSchema })
  .strict();
export type DraftDiscardAllBody = z.infer<typeof DraftDiscardAllBodySchema>;
