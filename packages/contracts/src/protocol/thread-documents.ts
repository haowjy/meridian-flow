import type { CommandId, DraftId } from "../ids.js";

export type ThreadDocumentRelationship = "editing" | "reading" | "created";

export type TurnTreeLine =
  | { op: "delete"; from: string }
  | { op: "move"; from: string; to: string }
  | { op: "copy"; from: string; to: string };

export type TurnLiveLineageDocumentItem = {
  documentId: string;
  uri: string;
  path: string;
  tree?: TurnTreeLine;
  block?: string;
  folder?: true;
} & ({ scope: "live" } | { scope: "draft"; draft: DraftId });

export type TurnReceiptControl = "undo" | "view_change";

export type TurnDraftState = "pending" | "applied" | "undone" | "discarded";

export interface TurnReceiptChip {
  drafts?: Record<string, TurnDraftState>;
  control: TurnReceiptControl;
  undone?: true;
  restore?: DraftId[];
  restored?: { draft: DraftId; press: CommandId }[];
}

export interface ListTurnLiveLineageResponse {
  documents: TurnLiveLineageDocumentItem[];
  receipt: TurnReceiptChip | null;
}
