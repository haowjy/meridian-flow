/**
 * Wire contracts for draft review metadata, lists and frozen Apply/Discard commands.
 *
 * Vocabulary: `branchId` is a `branches` row (the Work's whole branch), `itemKey`
 * (`${branchId}:${documentId}`) is the client's only identity for one reviewed document, and a
 * `hasDraft` reports text-room existence; addressed metadata supplies its stable draft id.
 * A command's `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import { z } from "zod";
import {
  type ClosedOwnerWhy,
  CommandIdSchema,
  type CommandOutcome,
  type Settlement,
} from "../commands/index.js";
import type { ParsedContextUri } from "../context-uri.js";
import type { BranchId, CommandId, DraftItemKey, ProjectId, ThreadId, UserId } from "../ids.js";
import type { ContextOperationReceipt } from "../protocol/context-operation.js";
import type { ReversalOutcome } from "../protocol/write-reversal.js";
import type { JsonObject, JsonValue, ToolContentPart } from "../threads/index.js";
import type { DraftOwnerKey } from "./owner.js";

/** JSON form of the kernel's SpanPatch; PM nodes cross the wire as node JSON. */
export type ApplySpanPatch = {
  base: { from: number; to: number };
  draft: { from: number; to: number };
  blocks: { type: string; [key: string]: unknown }[];
};

/** One frozen click, sent in the draft's FIFO. No revision or generation fence. */
export type ApplyClick = {
  commandId: CommandId;
  /** Stable room identity; omitted only for a no-room creation reveal. */
  draftId?: string;
  /** Base64 of Y.encodeSnapshotV2(room snapshot). Omitted for a tree cut alone and a whole cut. */
  snapshot?: string;
  /**
   * Apply every group the server's replica of `draftId` holds on receipt (`ApplyTextCut`'s whole
   * cut), with no snapshot and empty `groupIds` and `baseViewDelta`.
   */
  whole?: true;
  baseViewDelta: ApplySpanPatch[];
  groupIds: string[];
  /**
   * The click includes the document's tree records: its move, delete or creation. Without it a
   * text cut leaves a pending move or delete pending. A click with no text cut and no tree cut
   * is malformed.
   */
  tree?: true;
  saw?: TreeSaw;
};

/**
 * The cut the review rows were drawn from: for each list the Work's records are in, the list's
 * journal id and its Yjs state vector (base64) as the draft list read them. Records admitted
 * after it are ones the writer had not seen; they stay pending. A cut of another list (one
 * rebuilt under a new id) is no cut, and a scope left out is the server's own cut.
 */
export type TreeSaw = {
  project?: { list: string; vector: string };
  account?: { list: string; vector: string };
};

export type AppliedReviewItem = {
  itemKey: DraftItemKey;
  /** The committed move, when this click settled the item's branch tree row. */
  transition?: { from: string | null; to: string | null };
};

/**
 * What became of one half of an item. `landed`: this command changed live for it, and Un-Apply
 * takes that back. `settled` beside `landed: true` names what stayed out of it or came with it
 * (`left_out`, `restored`). With `landed: false` it says why, and is never empty. A note's own
 * `item` or `items` always names the entry's node.
 */
export type ApplyHalfResult =
  | { landed: true; settled?: Settlement[] }
  | { landed: false; settled: Settlement[] };

/** One item of an Apply: a document or a folder, with each of its two halves answered on its own. */
export type ApplyItemResult = {
  node: string;
  /** Present when the tree half ran: the click asked for the item's tree records, or the item has a pending create. */
  tree?: ApplyHalfResult & {
    /** Where live had the document before and after this command, when its tree half landed. */
    transition?: { from: string | null; to: string | null };
    /**
     * The live restore this command made of the document so its text could land: the record
     * Un-Apply takes back, and what `appliedNodes` reads to tell whether it still stands.
     */
    restore?: string;
  };
  /** Present when the click carried a text cut for the item. */
  text?: ApplyHalfResult;
};

/**
 * Every item an Apply was sent comes back once in `items`, in the click's order, with each half
 * landed or settled. Records that land without being asked for (a prerequisite create, the
 * prefix a selection the Work's tree can't keep falls back to) belong to no entry; Un-Apply
 * takes them back with the rest.
 */
export type ApplyClickResult = {
  status: "applied";
  commandId: CommandId;
  items: ApplyItemResult[];
  /**
   * The items with a landed half, derived from `items`. Kept for tabs opened before `items`
   * (one release) and for Un-Apply's read of stored answers; the app reads `items`.
   */
  applied: AppliedReviewItem[];
  overrode?: number;
};

export type ApplyClickAnswer = ApplyClickResult | { status: "conflict"; commandId: CommandId };
export type ApplyClickObservation = ApplyClickAnswer | { status: "none"; commandId: CommandId };

/**
 * Take back one Apply command: the surviving text groups of every document it applied, and
 * everything it settled in the tree (a restore it made included), in one command, fact by fact.
 * A tree fact something changed since stays (`left_out changed_since`), as does a created
 * document with text written since (`has_text`); a text group whose reversal would change a
 * word that holds writing made after the Apply stays applied and is named in `skippedGroupIds`.
 * A source whose Work was purged takes nothing back: `left_out purged`.
 *
 * Nothing that would change the notes of a closed owner (an archived or deleted Work, a chat in
 * Trash) is taken back: it is in `held`. Everything of the Apply still applied before this press
 * is in exactly one place: taken back (`reversedGroupIds`, `treeUndone`), left for a reason that
 * will not change (`left_out`, `skippedGroupIds`), or held. A text group an earlier Un-Apply took
 * back is in none. It took something back when `reversedGroupIds` or `treeUndone` is not empty.
 */
export type UnapplyClick = {
  commandId: CommandId;
  applyCommandId: CommandId;
};
export type UnapplyClickResult = {
  status: "unapplied";
  commandId: CommandId;
  /** The branch the command ran on: where a draft it swapped out is closed, and Restore names it. */
  branchId: BranchId;
  /** A text draft the Apply wrote in was closed: its half of the Un-Apply waits for a reopen. */
  draftHalfWaits: boolean;
  reversedGroupIds: string[];
  skippedGroupIds: string[];
  /** The nodes with a tree fact this command took back (a restore it undid included). */
  treeUndone: string[];
  /**
   * What is still applied because taking it back would change a closed owner's notes, per node:
   * `tree` when a tree fact of it is held, `groupIds` the text groups of it that are held. A node
   * whose tree fact went back and whose text is held is here with `tree: false`. `owner` is the
   * owner's name and `ownerKey` which owner it is, so a tab can tell from the Works and chats it
   * holds whether that owner has reopened. The `returned` lines of `settled` are derived from it.
   * The server always fills it; an answer stored before it existed has none, which reads as nothing
   * held.
   */
  held?: Array<{
    node: string;
    tree: boolean;
    groupIds: string[];
    why: ClosedOwnerWhy;
    owner?: string;
    ownerKey: DraftOwnerKey;
  }>;
  /**
   * `left_out` (what could not come back, one line per reason), `returned` (what stayed for a
   * closed owner, with `items`), or `already` (nothing was taken back and nothing was left:
   * everything was taken back before).
   */
  settled?: Settlement[];
};
export type UnapplyClickAnswer = UnapplyClickResult | { status: "conflict"; commandId: CommandId };

/**
 * The text cut of one document in an Apply. Frozen: the writer's click on the review room their
 * tab holds. Whole: every group of the draft as the server's replica has it on receipt, for a
 * click made with no room open (a Changes row, a folder, Apply all); a draft with no group then
 * is skipped, not refused.
 */
export type ApplyTextCut =
  | {
      draftId: string;
      /** Base64 of Y.encodeSnapshotV2(room snapshot). */
      snapshot: string;
      baseViewDelta: ApplySpanPatch[];
      groupIds: string[];
    }
  | { draftId: string; whole: true };

/**
 * Apply several nodes, documents or folders, as one command and one Undo step: each item's tree
 * cut (`tree`: land its pending tree records) and its text cut. An item has at least one of the
 * two. The per-document click is this command with one item.
 */
export type ApplyItemsClick = {
  commandId: CommandId;
  items: { node: string; tree?: true; text?: ApplyTextCut }[];
  saw?: TreeSaw;
};

/**
 * Restore a Discard, from the notice right after it or from Trash: the Work gets fresh pending
 * copies of the tree records it settled, and the text drafts it closed reopen as the same rows
 * in the Work's current branch. `discardCommandId` may name a restore too, which swaps the text
 * it closed back in.
 */
export type UndoDiscardClick = {
  commandId: CommandId;
  discardCommandId: CommandId;
};
export type UndoDiscardResult = {
  status: "restored";
  commandId: CommandId;
  /** The Discard (or earlier restore) this took the members of. */
  discardCommandId: CommandId;
  /** The Work's current branch: where the copies and the reopened drafts are. */
  branchId: BranchId;
  /** What came back: tree records copied and text drafts reopened. */
  restored: number;
  /** Newer drafts of the same documents this restore closed, now members of its own entry. */
  swapped: number;
  /** What the Discard held that could not come back: a node or document that has been purged. */
  leftOut: number;
  /**
   * Why `restored` is 0: `returned` (the draft's owner is closed), `already` (a restore took the
   * members), `left_out purged` (the entry is gone from Trash or what it held was purged).
   */
  settled?: Settlement[];
};
export type UndoDiscardAnswer = UndoDiscardResult | { status: "conflict"; commandId: CommandId };

/**
 * The document half of a Trash entry for a Discard (or for a restore that swapped a newer draft
 * out): the command, and the text drafts it closed that are still closed. The tree half is the
 * tree's own answer for the same command id; an entry with no member in either is not listed.
 */
export type DiscardEntry = {
  commandId: CommandId;
  kind: "discard" | "undo_discard" | "unapply";
  /** When the command ran: the entry leaves Trash 30 days later. */
  at: string;
  /** The branch the command ran on; Restore names it. */
  branchId: BranchId;
  workId: string | null;
  drafts: { draftId: string; documentId: string }[];
};

/** `GET /api/projects/:projectId/context/trash/discards`: entries with a member in either half. */
export type ListDiscardEntriesResponse = {
  entries: (DiscardEntry & {
    /** What the command settled in the tree and no restore has taken. */
    tree: {
      records: number;
      /** Every node those records are on: with the drafts' documents, what an Undo of a restore discards again. */
      nodes: string[];
      created: { node: string; kind: string; name: string; path: string[] }[];
    };
  })[];
};

/** What one kind's effect answered, as stored in a command's outcome. */
export type StoredDocumentCommandResult =
  | DiscardCommandResult
  | ApplyClickResult
  | UnapplyClickResult
  | UndoDiscardResult
  | ModelEditCommandResult
  | ReverseTurnCommandResult
  | CopyCommandResult;

/** A chat card's Undo or Redo: always `done`; the outcome says what changed and what each target left. */
export type ReverseTurnCommandResult = {
  status: "reversed";
  outcome: ReversalOutcome;
};

/** A Copy: the receipt the writer's client reads, which holds the created ids; `settled` says what it left undone. */
export type CopyCommandResult = {
  status: "copied";
  receipt: ContextOperationReceipt;
  settled?: Settlement[];
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

/**
 * A model's edit settled: `edited` committed it; `returned` answered it with the document as it
 * stands and changed nothing (`settled` says why); `refused` answered it with nothing changed.
 */
export type ModelEditCommandResult = {
  status: "edited" | "returned" | "refused";
  toolResult: ModelEditToolResult;
  settled?: Settlement[];
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
  /** The text draft's id, whose room the review opens; null when the item has no text draft. */
  draftId: string | null;
  /** Whether the item has a text draft (an empty create or image may not). */
  hasDraft: boolean;
  /**
   * The text draft's changes against its review base, as the review groups them, counted by the
   * server shortly after each write; 0 with no text draft.
   */
  textChanges: number;
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
   * Live has the document in Trash while the branch keeps it (a move, a rename or text the
   * branch has in it), in any area: Apply brings it back, at its name or the next free leaf
   * name, before merging. A document the branch deletes is never `deletedLive`.
   */
  deletedLive: boolean;
  /** For `deletedLive`: where live last had it, the area it was deleted from. */
  deletedFrom?: Pick<ParsedContextUri, "scheme" | "path">;
  /**
   * The branch's move, delete or creation of the document, when it has one. `movedFrom` is where
   * live has it now (`contextLocation` is where the branch puts it).
   */
  tree: {
    movedFrom?: Pick<ParsedContextUri, "scheme" | "path">;
    deleted?: true;
  } | null;
  /** Chats with pending agent writes in this item, latest first. Candidates: a chat's writes may be overwritten. */
  actorThreads: { threadId: string; title: string | null }[];
  /** The draft holds a change no chat is known to have written: the writer's own typing, or evidence in doubt. Like another chat in `actorThreads`, it makes the draft shared. */
  unattributed: boolean;
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
  /** The folders the Work's tree changes (it has a row on). */
  folders: { id: string }[];
  /**
   * The owner is a conversation lineage with no live chat (every chat in it is in Trash):
   * its drafts take no text and no Apply, only a whole Discard, until a chat is restored.
   * Always false for a Work, whose archive state the Work itself carries.
   */
  frozen: boolean;
  /**
   * The cut the items were read at: each list's vector, read before the rows. An Apply pressed on
   * these rows sends it, so what lands is what the rows showed.
   */
  saw: TreeSaw;
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

/** What a model edit's command row holds: its result, or `never` when the call was stopped before it ran. */
export type ModelEditOutcome =
  | { status: "done" | "refused"; result: ModelEditCommandResult }
  | { status: "never" };

/** What a document command's row holds. */
export type DocumentCommandOutcome = CommandOutcome<StoredDocumentCommandResult>;

/** Whether a settled item left review, and how (applied if anything reached live). */
export type DraftItemSettlement = {
  itemClosed: boolean;
  /** Present when `itemClosed`. */
  itemDisposition?: "applied" | "discarded";
};

/**
 * What a Discard answers, item or selection: it never refuses. `settled` says what became of an
 * item this command did not take: `already` (a Discard took it), `overtaken` (an Apply did), or
 * `returned` (the owner is closed, nothing changed).
 */
export type DiscardOutcomeNotes = { settled?: Settlement[] };

export type DraftDiscardResponse = {
  status: "discarded";
  branchId: BranchId;
  itemKey: DraftItemKey;
} & DraftItemSettlement &
  DiscardOutcomeNotes;

/**
 * One item's Discard on the server. `tree` ends only the branch's move or delete: a live chat's
 * Discard, whose text the writer reverts in the room. `item` ends everything the branch holds
 * on the document: a still-hidden creation, or a frozen owner's draft, whose room refuses the
 * writer's text. The URL names the branch.
 */
export type DraftDiscardRequest = {
  itemKey: DraftItemKey;
  commandId: CommandId;
  ends: "tree" | "item";
};

/**
 * `POST …/branches/:branchId/discard`, one server command either way. `all`: Discard all, every
 * change of the branch, which closes it; only an explicit `all` does that. `items`: any selection
 * of nodes, documents or folders (a folder group's ×, a folder changed alone), each ending as
 * `DraftDiscardRequest.ends` says; what stands on a node it discards goes with it (a document
 * moved into a folder the Work created). Its text halves close on the server, and Undo of a
 * Discard brings both halves back. Not strict at either level: a tab still on the old code sends
 * `draftSeenAt` on each item, and it is dropped, not a 400.
 */
export const BranchDiscardRequestSchema = z.union([
  z.object({ commandId: CommandIdSchema, all: z.literal(true) }),
  z.object({
    commandId: CommandIdSchema,
    items: z
      .array(
        z.object({
          node: z.string().min(1),
          ends: z.enum(["tree", "item"]),
        }),
      )
      .min(1),
  }),
]);
export type BranchDiscardRequest = z.infer<typeof BranchDiscardRequestSchema>;
/**
 * `discarded` with `all` and no `closed` means the branch closed; with `items`, `closed` names
 * the selected nodes nothing of the branch remains on, those an earlier command took included
 * (`settled` says which). A closed owner's bounce carries `closed: []`.
 */
export type BranchDiscardResponse = {
  status: "discarded";
  branchId: BranchId;
  closed?: string[];
} & DiscardOutcomeNotes;

/** A Discard's terminal body, exactly what its 200 carries. */
export type DiscardCommandResult = DraftDiscardResponse | BranchDiscardResponse;
