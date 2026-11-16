/**
 * Purpose: Defines JSON-natural thread-document and live-lineage DTOs.
 * Why independent: Chat rail data is shared by server routes and frontend query consumers.
 */
import type { DraftOwnerKey } from "../branches/owner.js";

export type ThreadDocumentRelationship = "editing" | "reading" | "created";

/**
 * What a turn did to where a document is, net of its own moves: deleted it, moved it, or
 * copied it there from another document. Locations are context URIs as they were when the
 * turn ran.
 */
export type TurnTreeLine =
  | { op: "delete"; from: string }
  | { op: "move"; from: string; to: string }
  /** `from` is the source document the copy read; `to` is where the copy landed. */
  | { op: "copy"; from: string; to: string };

export type TurnLiveLineageDocumentItem = {
  documentId: string;
  /** Where the document is now; where it was deleted from when it is deleted. */
  uri: string;
  /** Slash-prefixed display path derived from the canonical context URI. */
  path: string;
  /** Present when the turn moved or deleted the document. */
  tree?: TurnTreeLine;
  /** A folder the turn changed: `documentId` is its node id, and it has no document to open. */
  folder?: true;
} & (
  | { scope: "live" }
  /** The edit landed in a draft: `owner` names the Work or lineage whose branch held it. */
  | { scope: "draft"; owner: DraftOwnerKey }
);

/**
 * `live-active` offers Undo. The rest offer none: `undone` and `partly` say the card's Undo ran
 * (`partly` when some parts stayed), `expired` that nothing is left for it to act on.
 */
export type TurnReceiptState = "live-active" | "undone" | "partly" | "expired";

export type TurnReceiptControl = "undo" | "view_change";

/** What became of one half of a turn's drafted change to a node: still waiting, applied, or discarded. */
export type TurnDraftState = "pending" | "applied" | "discarded";

/**
 * What became of a turn's drafted tree change to a node: as a text half's, or `replaced` when a
 * later change to the same fact landed in its place.
 */
export type TurnTreeState = TurnDraftState | "replaced";

export interface TurnReceiptChip {
  /** Each drafted document's text, by document id; absent for documents the turn wrote live. */
  drafts?: Record<string, TurnDraftState>;
  /**
   * Each node's drafted tree change (a move, rename, delete or create, a folder's included), by
   * node id. Beside `drafts`, which says the text half.
   */
  trees?: Record<string, TurnTreeState>;
  skips?: import("./write-reversal.js").TurnInverseSkip[];
  /**
   * The Applies in force that took this reply's drafted changes. The card's Undo takes each back
   * whole by its Un-Apply, beside the reversal of the reply's other changes (`control`). `count`:
   * the changes the Apply took; `onlyThisTurn`: every one of them is this reply's.
   */
  applied?: TurnAppliedCommand[];
  state: TurnReceiptState;
  /** `undo`: the reply has changes besides its applied ones for the card's Undo to reverse. */
  control: TurnReceiptControl;
}

/** An Apply holding a reply's drafted changes, which the card's Undo takes back by its Un-Apply. */
export type TurnAppliedCommand = {
  commandId: string;
  branchId: string;
  count: number;
  onlyThisTurn: boolean;
};

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
