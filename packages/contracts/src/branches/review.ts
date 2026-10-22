/**
 * Wire contracts for draft review metadata, lists and frozen Apply/Discard commands.
 *
 * Vocabulary (D68): `branchId` is a `branches` row (the Work's whole branch), `itemKey`
 * (`${branchId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * `hasDraft` reports text-room existence; addressed metadata supplies its stable draft id.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type { BranchCommandId, BranchId, DraftItemKey } from "../ids.js";

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
  /** Stable room identity; omitted only for a no-room creation reveal. */
  draftId?: string;
  /** Base64 of Y.encodeSnapshotV2(room snapshot). Omitted only for a no-room creation reveal. */
  snapshot?: string;
  baseViewDelta: ApplySpanPatch[];
  groupIds: string[];
  /**
   * The writer knew this document was deleted from the manuscript and chose to bring it back:
   * a per-document Apply on an item showing it deleted, or an Apply all for a document its
   * confirmation named (D79). Without it, a deleted document answers `needs_restore`.
   */
  restore?: true;
  /**
   * The tree cut: the revision of the branch's row on the document the writer saw (the
   * item's `tree.revision`). The click applies the move, delete or creation that revision
   * holds, and answers `changed` if the row holds another now. A click with no text cut and
   * no tree cut is malformed; a text cut alone leaves a pending move or delete pending.
   */
  tree?: { revision: string | null };
};

export type ApplyClickRefusalReason =
  | "unsynced"
  | "malformed"
  | "work_archived"
  | "work_deleted"
  | "not_found"
  | "forbidden";

export type ApplyClickResult =
  | {
      status: "applied";
      commandId: BranchCommandId;
      overrode?: number;
      /**
       * The document had been deleted from the manuscript, and this Apply, sent with
       * `restore`, brought it back before merging (D79). The client words the notice from
       * this flag, per document.
       */
      restored?: true;
      /** A drafted move landed: where live had the document before (its path), named once. */
      replaced?: string;
    }
  /** The branch's row is not the revision the click froze: nothing applied (design-v2 §4). */
  | { status: "changed"; commandId: BranchCommandId }
  /**
   * The move's destination is still held live by another item of this branch that moves or
   * deletes it: apply that one first (Apply all orders them). Nothing applied.
   */
  | { status: "held"; commandId: BranchCommandId; by: { itemKey: DraftItemKey; path: string } }
  /**
   * The document is deleted from the manuscript and the click did not carry `restore`: the
   * writer's view did not know (a delete landed after it read the item, or after an Apply
   * all's confirmation named its documents). Nothing changed and the draft stays pending;
   * the client asks the writer, then sends a new click with `restore`.
   */
  | { status: "needs_restore"; commandId: BranchCommandId }
  | { status: "closed"; commandId: BranchCommandId }
  | { status: "refused"; commandId: BranchCommandId; reason: ApplyClickRefusalReason };

export type ApplyClickAnswer =
  | ApplyClickResult
  | { status: "pending" | "conflict"; commandId: BranchCommandId };
export type ApplyClickObservation =
  | ApplyClickAnswer
  | { status: "none"; commandId: BranchCommandId };

/** Stored writer-command outcomes. */
export type StoredBranchCommandResult = BranchCommandResult | ApplyClickResult;

/**
 * What blocks the item's Apply: another node took its path (Apply holds it until that one
 * moves). Whether live still has the document is `deletedLive`, a separate fact.
 */
export type DraftItemConflict =
  | { code: "path_taken"; path: string }
  /** Live still has this branch's other item at the destination; it moves or deletes it. */
  | { code: "pending_item"; path: string; itemKey: DraftItemKey };

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
  /** `isNew || binary`: one change, settled by item Apply or Discard only. */
  wholeItem: boolean;
  documentName: string | null;
  /** The document URI's scheme and leading-slash path in the branch's view, independent of the Work. */
  contextLocation: Pick<ParsedContextUri, "scheme" | "path"> | null;
  conflict: DraftItemConflict | null;
  /**
   * Deleted from the manuscript while this draft has it: live doesn't hold the document, and
   * Apply brings it back before merging (D79). Independent of `conflict`: another document
   * may also have taken its path.
   */
  deletedLive: boolean;
  /**
   * The branch's move, delete or creation of the document, when it has one: what a tree cut
   * applies (`revision`, frozen into the click) and what the row says. `movedFrom` is where
   * live has it now (`contextLocation` is where the branch puts it).
   */
  tree: {
    revision: string | null;
    movedFrom?: Pick<ParsedContextUri, "scheme" | "path">;
    deleted?: true;
  } | null;
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
  /**
   * The branch's move or delete of the document, which live doesn't show until Apply (D26):
   * where the branch puts it, or that it deletes it. Null when the branch only edits its text.
   */
  tree: { movedTo: Pick<ParsedContextUri, "scheme" | "path"> } | { deleted: true } | null;
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
