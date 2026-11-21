/**
 * Purpose: Defines JSON-natural thread-document and live-lineage DTOs.
 * Why independent: Chat rail data is shared by server routes and frontend query consumers.
 */

import type { DraftId } from "../ids.js";

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
  /** The edit landed in a draft. */
  | { scope: "draft"; draft: DraftId }
);

export type TurnReceiptControl = "undo" | "view_change";

/**
 * What became of a turn's drafted change to one document, text and tree halves folded into the
 * less settled one: still waiting, applied, taken back by the card's Undo, or discarded.
 */
export type TurnDraftState = "pending" | "applied" | "undone" | "discarded";

export interface TurnReceiptChip {
  /** Each drafted document's change, by document or node id; absent for what the turn wrote live. */
  drafts?: Record<string, TurnDraftState>;
  /** `undo`: the card's Undo would take something back. */
  control: TurnReceiptControl;
  /** The card's Undo ran and nothing is left for it; the card says "Undone". */
  undone?: true;
}

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
