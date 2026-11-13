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
} & (
  | { scope: "live" }
  /** The edit landed in a draft: `owner` names the Work or lineage whose branch held it. */
  | { scope: "draft"; owner: DraftOwnerKey }
);

export type TurnReceiptState =
  | "live-active"
  | "live-reversed"
  | "work-active"
  | "work-reversed"
  | "cant_undo_dependent"
  | "expired";

export type TurnReceiptControl = "undo" | "redo" | "view_change";

export interface TurnReceiptChip {
  skips?: import("./write-reversal.js").TurnInverseSkip[];
  state: TurnReceiptState;
  control: TurnReceiptControl;
}

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
