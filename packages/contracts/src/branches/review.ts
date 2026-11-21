/**
 * Wire contracts for draft review: the list of a Work's drafts, the hints on an open document,
 * and the stored results of document commands.
 *
 * Vocabulary: `branchId` is a `branches` row (the Work's whole branch), and `itemKey`
 * (`${branchId}:${documentId}`) is the client's identity for one reviewed document. A command's
 * `commandId` is client-generated; resends reuse it and the server deduplicates.
 */
import type { CommandOutcome, Settlement } from "../commands/index.js";
import type { ParsedContextUri } from "../context-uri.js";
import type { BranchId, DraftItemKey, ProjectId, ThreadId, UserId } from "../ids.js";
import type { ContextOperationReceipt } from "../protocol/context-operation.js";
import type { ReversalOutcome } from "../protocol/write-reversal.js";
import type { JsonObject, JsonValue, ToolContentPart } from "../threads/index.js";
import type { DraftOwnerKey } from "./owner.js";

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

/** What one kind's effect answered, as stored in a command's outcome. */
export type StoredDocumentCommandResult =
  | ModelEditCommandResult
  | ReverseTurnCommandResult
  | CopyCommandResult
  | import("./press.js").PressResult
  | import("./press.js").PressUndoResult;

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
  /** Whether the Work has suggestions in the document's text. */
  hasDraft: boolean;
  /** The Work's suggested changes in the document's text, counted by the server after each write. */
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
   * The branch's move, delete or creation of the document, when it has one. `movedFrom` is where
   * live has it now (`contextLocation` is where the branch puts it).
   */
  tree: {
    movedFrom?: Pick<ParsedContextUri, "scheme" | "path">;
    deleted?: true;
  } | null;
  /** Chats with pending agent writes in this item, latest first. Candidates: a chat's writes may be overwritten. */
  actorThreads: { threadId: string; title: string | null }[];
  /** The Work holds a suggestion no chat wrote: the writer's own. Like another chat in `actorThreads`, it makes the draft shared. */
  unattributed: boolean;
  /** When the Work's suggestions in the document last changed. */
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
   * The cut the items were read at: each list's vector, read before the rows. An Apply pressed on
   * these rows sends it, so what lands is what the rows showed.
   */
  saw: TreeSaw;
}

/** What a model edit's command row holds: its result, or `never` when the call was stopped before it ran. */
export type ModelEditOutcome =
  | { status: "done" | "refused"; result: ModelEditCommandResult }
  | { status: "never" };

/** What a document command's row holds. */
export type DocumentCommandOutcome = CommandOutcome<StoredDocumentCommandResult>;
