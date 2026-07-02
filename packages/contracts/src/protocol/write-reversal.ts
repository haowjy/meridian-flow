// Shared write reversal response contracts for context undo/redo APIs.

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "draft_under_review"
  | "internal_error";

export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired";

// Keep in sync with @meridian/agent-edit WriteStatus; do not couple the extractable package to wire contracts.
export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;

export interface DocumentReversalResult {
  uri: string;
  status: WriteStatus;
  text?: string;
}

export interface ReversalOutcome {
  status: WriteStatus;
  documents: DocumentReversalResult[];
}
