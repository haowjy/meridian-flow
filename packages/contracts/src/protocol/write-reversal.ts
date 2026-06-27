// Shared write reversal response contracts for context undo/redo APIs.

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "internal_error";

export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired";

export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;

export interface DocumentReversalResult {
  uri: string;
  status: WriteStatus;
  text?: string;
}

export interface TurnReversalOutcome {
  status: WriteStatus;
  documents: DocumentReversalResult[];
}
