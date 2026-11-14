/**
 * Wire contracts for draft review metadata, lists and frozen Apply/Discard commands.
 *
 * Vocabulary: `branchId` is a `branches` row (the Work's whole branch), `itemKey`
 * (`${branchId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * `hasDraft` reports text-room existence; addressed metadata supplies its stable draft id.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import type { ParsedContextUri } from "../context-uri.js";
import type {
  BranchId,
  DocumentCommandId,
  DraftItemKey,
  ProjectId,
  ThreadId,
  UserId,
} from "../ids.js";
import type { ContextOperationReceipt } from "../protocol/context-operation.js";
import type { ReversalOutcome } from "../protocol/write-reversal.js";
import type { JsonObject, JsonValue, ToolContentPart } from "../threads/index.js";
import type { DraftOwnerKey } from "./owner.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const DocumentCommandIdSchema = z.string().uuid();

/** JSON form of the kernel's SpanPatch; PM nodes cross the wire as node JSON. */
export type ApplySpanPatch = {
  base: { from: number; to: number };
  draft: { from: number; to: number };
  blocks: { type: string; [key: string]: unknown }[];
};

/** One frozen click, sent in the draft's FIFO. No revision or generation fence. */
export type ApplyClick = {
  commandId: DocumentCommandId;
  /** Stable room identity; omitted only for a no-room creation reveal. */
  draftId?: string;
  /** Base64 of Y.encodeSnapshotV2(room snapshot). Omitted only for a no-room creation reveal. */
  snapshot?: string;
  baseViewDelta: ApplySpanPatch[];
  groupIds: string[];
  /**
   * The writer knew this document was deleted from the manuscript and chose to bring it back:
   * a per-document Apply on an item showing it deleted, or an Apply all for a document its
   * confirmation named. Without it, a deleted document answers `needs_restore`.
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
  | "chat_frozen"
  | "work_deleted"
  | "not_found"
  | "ancestor_taken";

export type ApplyRenamedNote = {
  code: "renamed";
  /** The branch path the change asked for. */
  wanted: string;
  /** The live path the document claimed. */
  path: string;
};

export type AppliedReviewItem = {
  itemKey: DraftItemKey;
  /** The committed move, when this click settled the item's branch tree row. */
  transition?: { from: string | null; to: string | null };
  renamed?: ApplyRenamedNote;
};

export type ApplyClickResult =
  | {
      status: "applied";
      commandId: DocumentCommandId;
      /** Every item whose tree or text this click applied, dependency-first. */
      applied: AppliedReviewItem[];
      overrode?: number;
      /**
       * The document had been deleted from the manuscript, and this Apply, sent with
       * `restore`, brought it back before merging. The client words the notice from
       * this flag, per document.
       */
      restored?: true;
      /** A frozen text cut committed, including a cut whose live update was already contained. */
      textEffect?: true;
    }
  /** The branch's row is not the revision the click froze: nothing applied (design-v2 §4). */
  | { status: "changed"; commandId: DocumentCommandId }
  /**
   * The document is deleted from the manuscript and the click did not carry `restore`: the
   * writer's view did not know (a delete landed after it read the item, or after an Apply
   * all's confirmation named its documents). Nothing changed and the draft stays pending;
   * the client asks the writer, then sends a new click with `restore`.
   */
  | { status: "needs_restore"; commandId: DocumentCommandId }
  | { status: "closed"; commandId: DocumentCommandId }
  | { status: "refused"; commandId: DocumentCommandId; reason: ApplyClickRefusalReason };

export type ApplyClickAnswer =
  | ApplyClickResult
  | { status: "conflict"; commandId: DocumentCommandId };
export type ApplyClickObservation =
  | ApplyClickAnswer
  | { status: "none"; commandId: DocumentCommandId };

/**
 * Take back one Apply command: the surviving text groups of every document it applied, and
 * everything it settled in the tree (a restore it made included), in one command. The tree half
 * is allowed only while nothing else has changed the list since (`gone`), and refuses as
 * `superseded` when a record it would bring back no longer fits; either refuses the whole
 * command. A text group a later edit overlaps stays applied and is named in `skippedGroupIds`;
 * when every group stays, the tree half still comes back and the answer is `unapplied` with no
 * `reversedGroupIds`.
 */
export type UnapplyClick = {
  commandId: DocumentCommandId;
  applyCommandId: DocumentCommandId;
};
export type UnapplyClickResult =
  | {
      status: "unapplied";
      commandId: DocumentCommandId;
      reversedGroupIds: string[];
      skippedGroupIds: string[];
    }
  | { status: "closed"; commandId: DocumentCommandId }
  | { status: "refused"; commandId: DocumentCommandId; reason?: "gone" | "superseded" };
export type UnapplyClickAnswer =
  | UnapplyClickResult
  | { status: "conflict"; commandId: DocumentCommandId };

/** The text cut of one document in an Apply: the writer's frozen click on its review room. */
export type ApplyTextCut = {
  draftId: string;
  /** Base64 of Y.encodeSnapshotV2(room snapshot). */
  snapshot: string;
  baseViewDelta: ApplySpanPatch[];
  groupIds: string[];
};

/**
 * Apply several nodes, documents or folders, as one command and one Undo step: each item's tree
 * cut (the revision of the branch's row the writer saw; any row that holds another now answers
 * `changed` and nothing applies) and its text cut. An item has at least one of the two. The
 * per-document click is this command with one item.
 */
export type ApplyItemsClick = {
  commandId: DocumentCommandId;
  items: { node: string; tree?: { revision: string | null }; text?: ApplyTextCut }[];
  /** As on `ApplyClick`: the writer knew an item was deleted from the manuscript. */
  restore?: true;
};

/**
 * Take back a Discard: fresh pending copies, on the Work's current branch (the Discard's own
 * branch when it is still open, else the Work's new one), of the tree records it settled and of
 * the text drafts it closed.
 */
export type UndoDiscardClick = {
  commandId: DocumentCommandId;
  discardCommandId: DocumentCommandId;
};
export type UndoDiscardResult =
  | {
      status: "restored";
      commandId: DocumentCommandId;
      branchId: BranchId;
      /** The copies made: tree records and text drafts. */
      restored: number;
      /** What the Discard held that could not come back: a node or document that is gone, or a document the Work drafted again since. */
      leftOut: number;
    }
  | {
      status: "refused";
      commandId: DocumentCommandId;
      /**
       * `already_restored`: an Undo of this Discard already made its copies. `nothing_to_restore`:
       * the Discard settled no record and closed no draft that still exists.
       */
      reason:
        | "already_restored"
        | "nothing_to_restore"
        | "not_found"
        | "work_archived"
        | "chat_frozen"
        | "work_deleted";
    };
export type UndoDiscardAnswer =
  | UndoDiscardResult
  | { status: "conflict"; commandId: DocumentCommandId };

/** What one kind's effect answered, as stored in a command's outcome. */
export type StoredDocumentCommandResult =
  | DiscardCommandResult
  | ApplyClickResult
  | UnapplyClickResult
  | UndoDiscardResult
  | ModelEditCommandResult
  | ReverseTurnCommandResult
  | CopyCommandResult;

/** A chat card's Undo or Redo: the reversal's own outcome; `reversed` when it changed something. */
export type ReverseTurnCommandResult = {
  status: "reversed" | "refused";
  outcome: ReversalOutcome;
};

/** A Copy: the receipt the writer's client reads, which holds the created ids. */
export type CopyCommandResult = {
  status: "copied" | "refused";
  receipt: ContextOperationReceipt;
};

/** The tool result a model's edit stores: what its result block holds, before the block's own ids. */
export type ModelEditToolResult = {
  toolCallId: string;
  content: ToolContentPart[];
  result: JsonValue;
  isError?: boolean;
  metadata?: JsonObject;
};

/**
 * What names one model tool call's effect: the call, in its response, for its account. Both
 * the loop and a recovering process derive the same command id from it.
 */
export type ModelEditKey = {
  /** The chat, so a purge of it can delete the command's stored result. */
  threadId: ThreadId;
  responseId: string;
  toolCallId: string;
  accountId: UserId;
  projectId: ProjectId;
};

/** A model's edit settled: `edited` committed it, `refused` answered it with nothing changed. */
export type ModelEditCommandResult = {
  status: "edited" | "refused";
  toolResult: ModelEditToolResult;
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
  /** `isNew || binary`: one change, settled by item Apply or Discard only. */
  wholeItem: boolean;
  documentName: string | null;
  /** The document URI's scheme and leading-slash path in the branch's view, independent of the Work. */
  contextLocation: Pick<ParsedContextUri, "scheme" | "path"> | null;
  /**
   * Deleted from the manuscript while this draft has it: live doesn't hold the document, and
   * Apply brings it back at its prior or next free leaf name before merging.
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
  /**
   * The text draft's last committed write (content-free folds keep it), which a whole-item
   * Discard sends back as `draftSeenAt`. Meaningless when `hasDraft` is false.
   */
  updatedAt: string;
}

/**
 * One document's draft in an active branch, for the hint on an open document. The branch is
 * named by its own `label`; `owner` is who owns it, which the review address names.
 */
export interface DocumentDraftHint {
  branchId: BranchId;
  /** The draft's review identity for the document, as in the list. */
  itemKey: DraftItemKey;
  /** How the branch is named to the writer; null when it has no name (the client words that). */
  label: string | null;
  owner: DraftOwnerKey;
  /**
   * The branch's move or delete of the document, which live doesn't show until Apply:
   * where the branch puts it, or that it deletes it. Null when the branch only edits its text.
   */
  tree: { movedTo: Pick<ParsedContextUri, "scheme" | "path"> } | { deleted: true } | null;
}

export interface DocumentDraftHintsResponse {
  items: DocumentDraftHint[];
}

export interface ThreadDraftListResponse {
  items: ThreadDraftListItem[];
  /**
   * The owner's active branch, null when it has none: the `draft` its tree records carry, which
   * the browser replays as the Work's tree (a change to a folder alone lists no item).
   */
  branchId: BranchId | null;
  /**
   * The folders the Work's tree changes (it has a row on), each with the revision of that row:
   * the tree cut an Apply of the folder carries, as an item's `tree.revision` is a document's.
   */
  folders: { id: string; revision: string }[];
  /**
   * The owner is a conversation lineage with no live chat (every chat in it is in Trash):
   * its drafts take no text and no Apply, only a whole Discard, until a chat is restored.
   * Always false for a Work, whose archive state the Work itself carries.
   */
  frozen: boolean;
}

/** SQL-only addressed lookup; no text room is loaded or created. */
export type DraftMetadataResponse =
  | { status: "active"; draftId: string; reviewRoomName: string; item: ThreadDraftListItem }
  | { status: "tree-only"; item: ThreadDraftListItem }
  | { status: "gone" };

// --- Commands and outcomes (contract §4.5, §4.6) ---------------------------------------------
//
// A stored outcome answers every resend of its command id. Frozen Apply clicks have their own
// answer contract above.

/** Which kind of command a `commandId` was recorded for. */
export const DOCUMENT_COMMAND_KINDS = [
  "apply",
  "unapply",
  "discard",
  "undo_discard",
  "model_edit",
  "reverse_turn",
  "copy",
] as const;
export type DocumentCommandKind = (typeof DOCUMENT_COMMAND_KINDS)[number];

/** HTTP 409 code: the `commandId` was already used for a different command. */
export const DOCUMENT_COMMAND_CONFLICT_CODE = "command_conflict";

/** What a model edit's command row holds: its result, or `never` when the call was stopped before it ran. */
export type ModelEditOutcome =
  | { status: "done" | "refused"; result: ModelEditCommandResult }
  | { status: "never" };

/**
 * The outcome a command's transaction commits. `done`: the effect committed. `refused`: the
 * effect was turned away after the claim and nothing of it committed. `never`: the id was
 * claimed so that no attempt under it can take effect.
 */
export type DocumentCommandOutcome =
  | { status: "done" | "refused"; result: StoredDocumentCommandResult }
  | { status: "never" };

/** `GET /api/document-commands/:id`: the stored outcome, or `none` (also for another account's id). */
export type DocumentCommandLookupResponse =
  | { status: "none" }
  | { status: "stored"; kind: DocumentCommandKind; outcome: DocumentCommandOutcome };

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

/** `draft_changed`: the text draft moved on since the writer saw it (`draftSeenAt`); nothing ended. */
export type DraftDiscardRefusalStatus =
  | "stale"
  | "gone"
  | "whole_item"
  | "incomplete_class"
  | "draft_changed";

export type DraftDiscardResponse =
  | ({
      status: "discarded";
      branchId: BranchId;
      itemKey: DraftItemKey;
    } & DraftItemSettlement)
  | { status: DraftDiscardRefusalStatus; branchId: BranchId; itemKey: DraftItemKey };

/**
 * One item's Discard on the server. `tree` ends only the branch's move or delete: a live chat's
 * Discard, whose text the writer reverts in the room. `item` ends everything the branch holds
 * on the document: a still-hidden creation, or a frozen owner's draft, whose room refuses the
 * writer's text. `draftSeenAt` is the item's `updatedAt` the writer decided on (null: no text
 * draft); when sent, a draft that moved on refuses as `draft_changed`.
 */
export type DraftDiscardRequest = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  commandId: DocumentCommandId;
} & ({ ends: "tree" } | { ends: "item"; draftSeenAt?: string | null });

export const BranchDiscardAllRequestSchema = z.object({
  /** A `branches` row id, never a per-document draft id. */
  branchId: z.string().uuid(),
  commandId: DocumentCommandIdSchema,
});
export type BranchDiscardAllRequest = z.infer<typeof BranchDiscardAllRequestSchema>;
/** `discarded` closes the branch (the only wire signal of closure); `gone` names one that is not the Work's active branch. */
export type BranchDiscardAllResponse =
  | { status: "discarded"; branchId: BranchId }
  | { status: "gone"; branchId: BranchId };

/** A Discard's terminal body, exactly what its 200 carries. */
export type DiscardCommandResult = DraftDiscardResponse | BranchDiscardAllResponse;
